// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {mkdir, readFile, writeFile} from 'fs/promises';
import path from 'path';

import {app} from 'electron';

import type {AdapterFetchParams} from './types';

import {Logger} from 'common/log';

import {fetchServerJSONCached} from '../activityAPI';

type ChannelRecord = {
    id: string;
    display_name?: string;
    name?: string;
    type?: string;
};

type SnapshotResult = {
    ok: true;
    data: UnreadActivitySnapshot;
} | {
    ok: false;
    error: string;
};

export type UnreadActivitySnapshot = {
    mentionChannelIds: string[];
    reactionChannelIds: string[];
    postsByChannelId: Map<string, Array<Record<string, unknown>>>;
    channelsById: Map<string, ChannelRecord>;
};

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_DISK_TTL_MS = 10 * 60 * 1000;
const snapshotCache = new Map<string, {expiresAt: number; value: SnapshotResult}>();
const snapshotInFlight = new Map<string, Promise<SnapshotResult>>();
const startupDiskReadDone = new Set<string>();
const log = new Logger('UnreadActivitySnapshot');

type DiskSnapshotPayload = {
    savedAt: number;
    data: {
        mentionChannelIds: string[];
        reactionChannelIds: string[];
        postsByChannelId: Array<[string, Array<Record<string, unknown>>]>;
        channelsById: Array<[string, ChannelRecord]>;
    };
};

function toDiskPayload(snapshot: UnreadActivitySnapshot): DiskSnapshotPayload {
    return {
        savedAt: Date.now(),
        data: {
            mentionChannelIds: snapshot.mentionChannelIds,
            reactionChannelIds: snapshot.reactionChannelIds,
            postsByChannelId: Array.from(snapshot.postsByChannelId.entries()),
            channelsById: Array.from(snapshot.channelsById.entries()),
        },
    };
}

function fromDiskPayload(payload: DiskSnapshotPayload): UnreadActivitySnapshot {
    return {
        mentionChannelIds: payload.data.mentionChannelIds || [],
        reactionChannelIds: payload.data.reactionChannelIds || [],
        postsByChannelId: new Map(payload.data.postsByChannelId || []),
        channelsById: new Map(payload.data.channelsById || []),
    };
}

function getDiskSnapshotPath(userId: string) {
    return path.join(
        app.getPath('userData'),
        'activity',
        'snapshots',
        `${userId}.json`,
    );
}

async function loadSnapshotFromDisk(serverId: string, userId: string, pageSize: number): Promise<SnapshotResult | null> {
    try {
        const filePath = getDiskSnapshotPath(userId);
        const raw = await readFile(filePath, 'utf8');
        const payload = JSON.parse(raw) as DiskSnapshotPayload;
        const savedAt = Number(payload?.savedAt || 0);
        if (!savedAt || Date.now() - savedAt > SNAPSHOT_DISK_TTL_MS) {
            return null;
        }
        return {
            ok: true,
            data: fromDiskPayload(payload),
        };
    } catch (error) {
        log.silly('loadSnapshotFromDisk failed', serverId, userId, error);
        return null;
    }
}

async function saveSnapshotToDisk(serverId: string, userId: string, pageSize: number, result: SnapshotResult): Promise<void> {
    if (!result.ok) {
        return;
    }
    try {
        const filePath = getDiskSnapshotPath(userId);
        await mkdir(path.dirname(filePath), {recursive: true});
        await writeFile(filePath, JSON.stringify(toDiskPayload(result.data)), 'utf8');
    } catch (error) {
        log.silly('saveSnapshotToDisk failed', serverId, userId, error);
    }
}

function getPostsFromPayload(payload: unknown): Array<Record<string, unknown>> {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload.filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'));
    }

    const typed = payload as Record<string, unknown>;
    const order = Array.isArray(typed.order) ? typed.order.map(String) : [];
    const posts = (typed.posts || {}) as Record<string, unknown>;
    if (!order.length) {
        return [];
    }
    return order.map((id) => posts[id]).filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'));
}

function collectTeamIds(payload: unknown): string[] {
    if (!Array.isArray(payload)) {
        return [];
    }

    return payload.
        filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')).
        map((entry) => String(entry.team_id || '')).
        filter(Boolean);
}

function collectChannelIdsFromUserChannels(payload: unknown): string[] {
    if (!Array.isArray(payload)) {
        return [];
    }

    return payload.
        filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')).
        map((entry) => String(entry.id || '')).
        filter(Boolean);
}

function collectMentionChannelIds(payload: unknown): string[] {
    const ids = new Set<string>();
    const channelIdLike = /^[a-z0-9]{26}$/;

    const visit = (value: unknown, keyHint = '') => {
        if (!value || typeof value !== 'object') {
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((entry) => visit(entry));
            return;
        }

        const obj = value as Record<string, unknown>;
        const channelId = typeof obj.channel_id === 'string' ? obj.channel_id : '';
        const mentionCount = Number(obj.mention_count || 0);
        if (channelId && mentionCount > 0) {
            ids.add(channelId);
        }

        if (!channelId && keyHint && channelIdLike.test(keyHint) && mentionCount > 0) {
            ids.add(keyHint);
        }

        Object.entries(obj).forEach(([key, nested]) => visit(nested, key));
    };

    visit(payload);
    return Array.from(ids);
}

function collectUnreadChannelIds(payload: unknown): string[] {
    const ids = new Set<string>();
    const channelIdLike = /^[a-z0-9]{26}$/;

    const visit = (value: unknown, keyHint = '') => {
        if (!value || typeof value !== 'object') {
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((entry) => visit(entry));
            return;
        }

        const obj = value as Record<string, unknown>;
        const channelId = typeof obj.channel_id === 'string' ? obj.channel_id : '';
        const mentionCount = Number(obj.mention_count || 0);
        const msgCount = Number(obj.msg_count || 0);
        if (channelId && (mentionCount > 0 || msgCount > 0)) {
            ids.add(channelId);
        }

        if (!channelId && keyHint && channelIdLike.test(keyHint) && (mentionCount > 0 || msgCount > 0)) {
            ids.add(keyHint);
        }

        Object.entries(obj).forEach(([key, nested]) => visit(nested, key));
    };

    visit(payload);
    return Array.from(ids);
}

async function buildSnapshot(params: AdapterFetchParams): Promise<SnapshotResult> {
    if (!params.userId) {
        return {
            ok: true,
            data: {
                mentionChannelIds: [],
                reactionChannelIds: [],
                postsByChannelId: new Map(),
                channelsById: new Map(),
            },
        };
    }

    const unreadResponse = await fetchServerJSONCached(params.serverId, '/api/v4/users/me/teams/unread?include_collapsed_threads=true');
    if (!unreadResponse.ok) {
        return {ok: false, error: unreadResponse.error || 'failed to load teams/unread'};
    }

    const teamIds = collectTeamIds(unreadResponse.data);
    const perChannelUnreadPayloads: unknown[] = [];
    for (const teamId of teamIds) {
        const endpoints = [
            `/api/v4/users/${encodeURIComponent(params.userId)}/teams/${encodeURIComponent(teamId)}/channels/unread`,
            `/api/v4/users/me/teams/${encodeURIComponent(teamId)}/channels/unread`,
            `/api/v4/users/${encodeURIComponent(params.userId)}/teams/${encodeURIComponent(teamId)}/channels/unread?include_collapsed_threads=true`,
            `/api/v4/users/me/teams/${encodeURIComponent(teamId)}/channels/unread?include_collapsed_threads=true`,
        ];

        for (const endpoint of endpoints) {
            const response = await fetchServerJSONCached(params.serverId, endpoint);
            if (!response.ok) {
                continue;
            }
            perChannelUnreadPayloads.push(response.data);
            break;
        }
    }

    const channelsById = new Map<string, ChannelRecord>();
    let allChannelIds: string[] = [];
    const channelsResponse = await fetchServerJSONCached(params.serverId, '/api/v4/users/me/channels');
    if (channelsResponse.ok && Array.isArray(channelsResponse.data)) {
        channelsResponse.data.
            filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')).
            forEach((entry) => {
                const channelId = String(entry.id || '');
                if (!channelId) {
                    return;
                }
                channelsById.set(channelId, {
                    id: channelId,
                    display_name: String(entry.display_name || ''),
                    name: String(entry.name || ''),
                    type: String(entry.type || ''),
                });
            });
        allChannelIds = collectChannelIdsFromUserChannels(channelsResponse.data);
    }

    let mentionChannelIds = perChannelUnreadPayloads.
        flatMap((payload) => collectMentionChannelIds(payload)).
        filter((id, idx, arr) => arr.indexOf(id) === idx).
        slice(0, 30);
    let reactionChannelIds = perChannelUnreadPayloads.
        flatMap((payload) => collectUnreadChannelIds(payload)).
        filter((id, idx, arr) => arr.indexOf(id) === idx).
        slice(0, 30);

    if (!mentionChannelIds.length) {
        mentionChannelIds = allChannelIds.slice(0, 30);
    }
    if (!reactionChannelIds.length) {
        reactionChannelIds = allChannelIds.slice(0, 30);
    }

    const channelsToFetch = [...mentionChannelIds, ...reactionChannelIds].
        filter((id, idx, arr) => arr.indexOf(id) === idx).
        slice(0, 50);

    const postsByChannelId = new Map<string, Array<Record<string, unknown>>>();
    const limit = Math.max(10, Math.min(params.pageSize, 100));
    for (const channelId of channelsToFetch) {
        const endpoint = `/api/v4/users/${encodeURIComponent(params.userId)}/channels/${encodeURIComponent(channelId)}/posts/unread?limit_before=${limit}&limit_after=${limit}&skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false`;
        const response = await fetchServerJSONCached(params.serverId, endpoint);
        if (!response.ok) {
            postsByChannelId.set(channelId, []);
            continue;
        }
        postsByChannelId.set(channelId, getPostsFromPayload(response.data));
    }

    return {
        ok: true,
        data: {
            mentionChannelIds,
            reactionChannelIds,
            postsByChannelId,
            channelsById,
        },
    };
}

export async function getUnreadActivitySnapshot(params: AdapterFetchParams): Promise<SnapshotResult> {
    const key = params.userId;
    const now = Date.now();
    const cached = snapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
        log.silly('snapshot memory cache hit', {key});
        console.info('[UnreadActivitySnapshot] memory_cache_hit', {key});
        return cached.value;
    }

    const inFlight = snapshotInFlight.get(key);
    if (inFlight) {
        log.silly('snapshot in-flight hit', {key});
        console.info('[UnreadActivitySnapshot] inflight_hit', {key});
        return inFlight;
    }

    const request = (async () => {
        const currentCached = snapshotCache.get(key);
        if (currentCached && currentCached.expiresAt > Date.now()) {
            log.silly('snapshot memory cache hit after lock', {key});
            console.info('[UnreadActivitySnapshot] memory_cache_hit_after_lock', {key});
            return currentCached.value;
        }

        if (!startupDiskReadDone.has(key)) {
            startupDiskReadDone.add(key);
            const diskSnapshot = await loadSnapshotFromDisk(params.serverId, params.userId, params.pageSize);
            if (diskSnapshot) {
                log.info('snapshot disk cache hit', {key});
                console.info('[UnreadActivitySnapshot] disk_cache_hit', {key});
                snapshotCache.set(key, {
                    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
                    value: diskSnapshot,
                });
                return diskSnapshot;
            }
            log.info('snapshot disk cache miss', {key});
            console.info('[UnreadActivitySnapshot] disk_cache_miss', {key});
        }

        log.info('snapshot network fetch', {key});
        console.info('[UnreadActivitySnapshot] network_fetch', {key});
        const result = await buildSnapshot(params);
        await saveSnapshotToDisk(params.serverId, params.userId, params.pageSize, result);
        snapshotCache.set(key, {
            expiresAt: Date.now() + SNAPSHOT_TTL_MS,
            value: result,
        });
        return result;
    })().finally(() => {
        snapshotInFlight.delete(key);
    });

    snapshotInFlight.set(key, request);
    return request;
}
