// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {dedupeActivityItems, withCanonicalId} from 'common/activity/canonical';
import type {ActivityAggregationService as ActivityAggregationServiceContract, ActivityLoadContext} from 'common/activity/interfaces';
import {mergeActivityItems} from 'common/activity/merge';
import type {ActivityEventKind, ActivityItem, ActivityPage, PersistedActivityState} from 'common/activity/types';
import {Logger} from 'common/log';

import {getUserAvatarURL, getUserIdForServer} from './activityAPI';
import activityPersistence from './activityPersistence';
import activityStateStore from './activityStateStore';
import {DMGMAdapter} from './adapters/dmGmAdapter';
import {MentionsAdapter} from './adapters/mentionsAdapter';
import {ReactionsAdapter} from './adapters/reactionsAdapter';
import {RemindersAdapter} from './adapters/remindersAdapter';
import {ThreadsAdapter} from './adapters/threadsAdapter';
import type {ActivitySourceAdapter} from './adapters/types';

const log = new Logger('ActivityAggregationService');

const DEFAULT_PAGE_SIZE = 30;
const MAX_PERSISTED_ITEMS = 5000;
const INITIAL_MIN_NEW_ITEMS = 30;
const INITIAL_MAX_ITERATIONS = 1;
const OLDER_MIN_NEW_ITEMS = 100;
const OLDER_MAX_ITERATIONS = 20;
const DISPLAY_WINDOW_STEP_MS = 7 * 24 * 60 * 60 * 1000;

type AdapterCursorMap = Partial<Record<ActivityEventKind, string>>;

const SOURCE_ENV_KEY: Record<ActivityEventKind, string> = {
    mention: 'MM_DESKTOP_ACTIVITY_SOURCE_MENTION',
    thread_reply: 'MM_DESKTOP_ACTIVITY_SOURCE_THREAD_REPLY',
    reaction: 'MM_DESKTOP_ACTIVITY_SOURCE_REACTION',
    dm: 'MM_DESKTOP_ACTIVITY_SOURCE_DM',
    gm: 'MM_DESKTOP_ACTIVITY_SOURCE_GM',
    reminder: 'MM_DESKTOP_ACTIVITY_SOURCE_REMINDER',
};

const SHARED_MENTION_REACTION_ENV_KEY = 'MM_DESKTOP_ACTIVITY_SOURCE_MENTION_REACTION';

function resolveSourceEnvValue(kind: ActivityEventKind): string | undefined {
    if (kind === 'mention' || kind === 'reaction') {
        const shared = process.env[SHARED_MENTION_REACTION_ENV_KEY];
        if (shared) {
            return shared;
        }
    }
    return process.env[SOURCE_ENV_KEY[kind]];
}

function isSourceEnabled(kind: ActivityEventKind): boolean {
    const raw = resolveSourceEnvValue(kind);
    if (!raw) {
        return true;
    }

    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function parsePage(cursor?: string): number {
    if (!cursor) {
        return 0;
    }
    const page = Number(cursor);
    return Number.isFinite(page) ? page : 0;
}

function resolveInitialVisibleSince(nowMs: number): number {
    return Math.max(0, nowMs - DISPLAY_WINDOW_STEP_MS);
}

function resolveVisibleSince(mode: 'initial' | 'older', nowMs: number, state?: PersistedActivityState): number {
    const previousVisibleSince = state?.checkpoint?.visibleSinceMs ?? resolveInitialVisibleSince(nowMs);
    if (mode === 'older') {
        return Math.max(0, previousVisibleSince - DISPLAY_WINDOW_STEP_MS);
    }
    return previousVisibleSince;
}

function toPersistedState(context: ActivityLoadContext, page: ActivityPage, allItems = page.items): PersistedActivityState {
    return {
        serverId: context.serverId,
        fetchedAt: Date.now(),
        uiCursor: page.uiCursor,
        sourceCursors: page.sourceCursors,
        checkpoint: page.checkpoint,
        items: allItems.slice(0, MAX_PERSISTED_ITEMS).map((item) => ({
            canonicalId: item.canonicalId,
            eventKind: item.eventKind,
            serverId: item.serverId,
            targetUserId: item.targetUserId,
            eventTs: item.eventTs,
            previewText: item.previewText,
            postId: item.postId,
            reminderId: item.reminderId,
            channelId: item.channelId,
            threadId: item.threadId,
            actorUserId: item.actorUserId,
            actorAvatarUrl: item.actorAvatarUrl,
            isUnread: item.isUnread,
            sourceRef: item.sourceRef,
        })),
    };
}

export class ActivityAggregationService implements ActivityAggregationServiceContract {
    private readonly adapters: ActivitySourceAdapter[];

    constructor() {
        const allAdapters: ActivitySourceAdapter[] = [
            new MentionsAdapter(),
            new ThreadsAdapter(),
            new ReactionsAdapter(),
            new DMGMAdapter(),
            new RemindersAdapter(),
        ];

        this.adapters = allAdapters.filter((adapter) => isSourceEnabled(adapter.kind));
        log.info('activity sources configured', {
            enabledSources: this.adapters.map((adapter) => adapter.kind),
            disabledSources: Object.keys(SOURCE_ENV_KEY).filter((kind) => !isSourceEnabled(kind as ActivityEventKind)),
        });
    }

    emptyPage = (): ActivityPage => {
        return {
            items: [],
            uiCursor: undefined,
            sourceCursors: {},
            checkpoint: {
                watermarkTs: 0,
                mergeSequence: 0,
            },
            errors: [],
            hasMore: false,
        };
    };

    private resolveUserId = async (context: ActivityLoadContext) => {
        if (context.userId) {
            return context.userId;
        }
        const resolved = await getUserIdForServer(context.serverId);
        return resolved || '';
    };

    private fetchAdapters = async (context: ActivityLoadContext, mode: 'initial' | 'older', state?: PersistedActivityState): Promise<{page: ActivityPage; allItems: ActivityItem[]}> => {
        const nowMs = context.nowMs || Date.now();
        const pageSize = context.pageSize || DEFAULT_PAGE_SIZE;
        const userId = await this.resolveUserId(context);
        const sinceMs = 0;
        const beforeMs = undefined;
        const visibleSinceMs = resolveVisibleSince(mode, nowMs, state);
        const errors: ActivityPage['errors'] = [];
        const adapterStatsMap = new Map<ActivityEventKind, {source: ActivityEventKind; count: number; error?: string}>();

        const accumulateAdapterStats = (source: ActivityEventKind, count: number, error?: string) => {
            const previous = adapterStatsMap.get(source);
            if (!previous) {
                adapterStatsMap.set(source, {source, count, error});
                return;
            }
            adapterStatsMap.set(source, {
                source,
                count: previous.count + count,
                error: previous.error || error,
            });
        };

        const runAdapters = async (adapters: ActivitySourceAdapter[], cursorMap: AdapterCursorMap): Promise<{
            items: ActivityItem[];
            nextCursorMap: AdapterCursorMap;
            activeKinds: Set<ActivityEventKind>;
        }> => {
            const nextCursorMap: AdapterCursorMap = {};
            const activeKinds = new Set<ActivityEventKind>();

            const runs = adapters.map(async (adapter) => {
                const cursor = cursorMap[adapter.kind];
                const page = parsePage(cursor);
                if (adapter.kind === 'mention') {
                    console.info('[ActivityAggregationService] invoking mentions adapter', {
                        serverId: context.serverId,
                        mode,
                        page,
                        pageSize,
                        hasUserId: Boolean(userId),
                    });
                }
                const result = await adapter.fetch({
                    serverId: context.serverId,
                    userId,
                    pageSize,
                    page,
                    sinceMs,
                    beforeMs,
                });

                if (result.nextCursor) {
                    nextCursorMap[adapter.kind] = result.nextCursor;
                    activeKinds.add(adapter.kind);
                }

                if (result.error) {
                    errors.push({
                        source: adapter.kind,
                        message: result.error,
                        retriable: true,
                    });
                }

                accumulateAdapterStats(adapter.kind, result.items.length, result.error);
                return result.items;
            });

            return {
                items: (await Promise.all(runs)).flat().map(withCanonicalId),
                nextCursorMap,
                activeKinds,
            };
        };

        let merged: ActivityItem[];
        let sourceCursors: AdapterCursorMap = {};

        const targetNewItems = mode === 'older' ? OLDER_MIN_NEW_ITEMS : INITIAL_MIN_NEW_ITEMS;
        const maxIterations = mode === 'older' ? OLDER_MAX_ITERATIONS : INITIAL_MAX_ITERATIONS;
        merged = mode === 'older' && state ? state.items : [];
        let totalNewItems = 0;
        let activeAdapters = this.adapters;
        let cursorMap: AdapterCursorMap = mode === 'older' && state ? {...(state.sourceCursors || {})} : {};

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            if (!activeAdapters.length || totalNewItems >= targetNewItems) {
                break;
            }

            const round = await runAdapters(activeAdapters, cursorMap);
            const nextMerged = mode === 'older' && state ? mergeActivityItems(merged, round.items) : dedupeActivityItems([...merged, ...round.items]);
            const newlyAdded = Math.max(0, nextMerged.length - merged.length);

            merged = nextMerged;
            totalNewItems += newlyAdded;

            sourceCursors = round.nextCursorMap;
            cursorMap = round.nextCursorMap;
            activeAdapters = this.adapters.filter((adapter) => round.activeKinds.has(adapter.kind));

            // Stop immediately when no new items are added in a round.
            if (newlyAdded === 0) {
                break;
            }
        }

        const sorted = mergeActivityItems([], merged);
        const visibleItems = sorted.filter((item) => item.eventTs >= visibleSinceMs);
        const hasHiddenOlderItems = sorted.length > visibleItems.length;
        const watermarkTs = sorted.length ? sorted[sorted.length - 1].eventTs : (state?.checkpoint.watermarkTs || 0);
        const adapterStats = Array.from(adapterStatsMap.values());

        log.info('activity fetch', {
            mode,
            serverId: context.serverId,
            userIdResolved: Boolean(userId),
            totalItems: sorted.length,
            visibleItems: visibleItems.length,
            visibleSinceMs,
            errors: errors.length,
            adapterStats,
        });

        return {
            page: {
                items: visibleItems.slice(0, MAX_PERSISTED_ITEMS),
                uiCursor: String(watermarkTs || nowMs),
                sourceCursors,
                checkpoint: {
                    watermarkTs,
                    mergeSequence: (state?.checkpoint.mergeSequence || 0) + 1,
                    visibleSinceMs,
                },
                errors,
                hasMore: hasHiddenOlderItems || Object.values(sourceCursors).some(Boolean),
            },
            allItems: sorted.slice(0, MAX_PERSISTED_ITEMS),
        };
    };

    loadInitial = async (context: ActivityLoadContext): Promise<ActivityPage> => {
        const result = await this.fetchAdapters(context, 'initial');
        const persisted = toPersistedState(context, result.page, result.allItems);
        activityStateStore.set(persisted);
        await activityPersistence.save(persisted);
        return result.page;
    };

    loadOlder = async (context: ActivityLoadContext, state: PersistedActivityState): Promise<ActivityPage> => {
        const result = await this.fetchAdapters(context, 'older', state);
        const persisted = toPersistedState(context, result.page, result.allItems);
        activityStateStore.set(persisted);
        await activityPersistence.save(persisted);
        return result.page;
    };

    refresh = async (context: ActivityLoadContext, state?: PersistedActivityState): Promise<ActivityPage> => {
        const result = await this.fetchAdapters(context, 'initial', state);
        const persisted = toPersistedState(context, result.page, result.allItems);
        activityStateStore.set(persisted);
        await activityPersistence.save(persisted);
        return result.page;
    };

    searchLocal = (query: string, items: ActivityItem[]): ActivityItem[] => {
        const normalized = query.trim().toLowerCase();
        const hydrated = items.map((item) => {
            if (item.actorAvatarUrl || !item.actorUserId) {
                return item;
            }
            return {
                ...item,
                actorAvatarUrl: getUserAvatarURL(item.serverId, item.actorUserId),
            };
        });

        if (!normalized) {
            return hydrated;
        }

        return hydrated.filter((item) => {
            const haystack = [
                item.previewText,
                item.channelId,
                item.threadId,
                item.postId,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(normalized);
        });
    };

    getState = async (serverId: string): Promise<PersistedActivityState | null> => {
        const memoryState = activityStateStore.get(serverId);
        if (memoryState) {
            return memoryState;
        }

        const diskState = await activityPersistence.load(serverId);
        if (diskState) {
            activityStateStore.set(diskState);
        }
        return diskState;
    };
}

const activityAggregationService = new ActivityAggregationService();
export default activityAggregationService;
