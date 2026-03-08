// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {IpcMainEvent, IpcMainInvokeEvent} from 'electron';

import type {ActivityLoadContext} from 'common/activity/interfaces';
import type {ActivityPage, PersistedActivityState} from 'common/activity/types';
import {ACTIVITY_CLOSE_TAB, ACTIVITY_SELECT_TAB, ACTIVITY_SIDEBAR_ACTIVE, BROWSER_HISTORY_PUSH} from 'common/communication';
import {Logger} from 'common/log';
import ActivityAggregationService from 'main/activity/activityAggregationService';
import activityPersistence from 'main/activity/activityPersistence';
import activityStateStore from 'main/activity/activityStateStore';
import {getActivityViewBounds, setActivitySidebarOpen} from 'main/activitySidebarState';
import ViewManager from 'main/views/viewManager';
import MainWindow from 'main/windows/mainWindow';

import {shouldHaveBackBar} from '../utils';

type ActivityRequestPayload = {
    serverId?: string;
    userId?: string;
    pageSize?: number;
    query?: string;
};

type ActivityCachePayload = {
    serverId?: string;
};

const MAX_QUERY_LENGTH = 500;
const log = new Logger('ActivityIntercom');
const initialInFlightByServer = new Map<string, Promise<ActivityPage>>();
const lastInitialCompletedAtByServer = new Map<string, number>();
const REFRESH_SKIP_AFTER_INITIAL_MS = 5000;

function splitPathSegments(pathname?: string) {
    return (pathname || '').split('/').filter(Boolean);
}

function getCurrentTeamPathPrefix(targetView: NonNullable<ReturnType<typeof ViewManager.getCurrentView>>) {
    const currentSegments = splitPathSegments(targetView.currentURL?.pathname);
    if (!currentSegments.length) {
        return '';
    }

    const baseSegments = splitPathSegments(targetView.view.url?.pathname);
    const startIndex = currentSegments.slice(0, baseSegments.length).join('/') === baseSegments.join('/') ? baseSegments.length : 0;
    const teamSegment = currentSegments[startIndex];
    if (!teamSegment) {
        return '';
    }

    return `/${[...baseSegments, teamSegment].join('/')}`;
}

function isActivityDisabled() {
    return process.env.MM_DESKTOP_DISABLE_ACTIVITY === 'true';
}

function normalizePayload(payload: ActivityRequestPayload): ActivityRequestPayload {
    return {
        serverId: (payload?.serverId || '').trim(),
        userId: payload?.userId?.trim(),
        pageSize: payload?.pageSize,
        query: (payload?.query || '').slice(0, MAX_QUERY_LENGTH),
    };
}

function resolveServerId(event: IpcMainInvokeEvent, payload: ActivityRequestPayload): string {
    const normalizedServerId = (payload?.serverId || '').trim();
    if (normalizedServerId) {
        return normalizedServerId;
    }

    return ViewManager.getViewByWebContentsId(event.sender.id)?.view.server.id || '';
}

function toContext(event: IpcMainInvokeEvent, payload: ActivityRequestPayload): ActivityLoadContext {
    const normalized = normalizePayload(payload);
    return {
        serverId: resolveServerId(event, normalized),
        userId: normalized.userId || '',
        pageSize: normalized.pageSize,
    };
}

function toPageFromState(state: PersistedActivityState): ActivityPage {
    const visibleSinceMs = state.checkpoint.visibleSinceMs || 0;
    const visibleItems = visibleSinceMs ? state.items.filter((item) => item.eventTs >= visibleSinceMs) : state.items;
    const hasHiddenOlderItems = visibleItems.length < state.items.length;
    return {
        items: visibleItems,
        uiCursor: state.uiCursor,
        sourceCursors: state.sourceCursors,
        checkpoint: state.checkpoint,
        errors: [],
        hasMore: hasHiddenOlderItems || Boolean(Object.values(state.sourceCursors || {}).some(Boolean)),
    };
}

export async function handleActivityLoadInitial(event: IpcMainInvokeEvent, payload: ActivityRequestPayload) {
    if (isActivityDisabled()) {
        return ActivityAggregationService.emptyPage();
    }
    const context = toContext(event, payload);
    log.info('loadInitial request', {serverId: context.serverId, senderId: event.sender.id, pageSize: context.pageSize});
    if (!context.serverId) {
        return ActivityAggregationService.emptyPage();
    }
    const existing = initialInFlightByServer.get(context.serverId);
    if (existing) {
        return existing;
    }

    const request = ActivityAggregationService.loadInitial(context).finally(() => {
        initialInFlightByServer.delete(context.serverId);
        lastInitialCompletedAtByServer.set(context.serverId, Date.now());
    });
    initialInFlightByServer.set(context.serverId, request);
    return request;
}

export async function handleActivityGetSnapshot(event: IpcMainInvokeEvent, payload: ActivityRequestPayload) {
    if (isActivityDisabled()) {
        return ActivityAggregationService.emptyPage();
    }
    const context = toContext(event, payload);
    log.info('getSnapshot request', {serverId: context.serverId, senderId: event.sender.id});
    if (!context.serverId) {
        return ActivityAggregationService.emptyPage();
    }
    const state = await ActivityAggregationService.getState(context.serverId);
    if (!state) {
        return ActivityAggregationService.emptyPage();
    }

    return toPageFromState(state);
}

export async function handleActivityLoadOlder(event: IpcMainInvokeEvent, payload: ActivityRequestPayload) {
    if (isActivityDisabled()) {
        return ActivityAggregationService.emptyPage();
    }
    const context = toContext(event, payload);
    log.info('loadOlder request', {serverId: context.serverId, senderId: event.sender.id, pageSize: context.pageSize});
    if (!context.serverId) {
        return ActivityAggregationService.emptyPage();
    }
    const state = await ActivityAggregationService.getState(context.serverId);
    if (!state) {
        return ActivityAggregationService.loadInitial(context);
    }
    return ActivityAggregationService.loadOlder(context, state as PersistedActivityState);
}

export async function handleActivityRefresh(event: IpcMainInvokeEvent, payload: ActivityRequestPayload) {
    if (isActivityDisabled()) {
        return ActivityAggregationService.emptyPage();
    }
    const context = toContext(event, payload);
    log.info('refresh request', {serverId: context.serverId, senderId: event.sender.id, pageSize: context.pageSize});
    if (!context.serverId) {
        return ActivityAggregationService.emptyPage();
    }

    const initialInFlight = initialInFlightByServer.get(context.serverId);
    if (initialInFlight) {
        log.info('refresh coalesced with loadInitial', {serverId: context.serverId, senderId: event.sender.id});
        return initialInFlight;
    }

    const state = await ActivityAggregationService.getState(context.serverId);
    const lastInitialCompletedAt = lastInitialCompletedAtByServer.get(context.serverId) || 0;
    if (state && Date.now() - lastInitialCompletedAt < REFRESH_SKIP_AFTER_INITIAL_MS) {
        log.info('refresh skipped shortly after loadInitial', {serverId: context.serverId, senderId: event.sender.id});
        return toPageFromState(state);
    }

    return ActivityAggregationService.refresh(context, state || undefined);
}

export async function handleActivitySearchLocal(event: IpcMainInvokeEvent, payload: ActivityRequestPayload) {
    if (isActivityDisabled()) {
        return [];
    }
    const normalized = normalizePayload(payload);
    log.info('searchLocal request', {senderId: event.sender.id, queryLength: (normalized.query || '').length});
    const serverId = resolveServerId(event, normalized);
    if (!serverId) {
        return [];
    }
    const state = await ActivityAggregationService.getState(serverId);
    if (!state) {
        return [];
    }
    return ActivityAggregationService.searchLocal(normalized.query || '', state.items);
}

export async function handleActivityCacheStats(_: IpcMainInvokeEvent, payload: ActivityCachePayload) {
    const serverId = (payload?.serverId || '').trim();
    const stats = await activityPersistence.getCacheStats(serverId || undefined);
    return {
        ...stats,
        serverId: serverId || undefined,
    };
}

export async function handleActivityCacheClear(_: IpcMainInvokeEvent, payload: ActivityCachePayload) {
    const serverId = (payload?.serverId || '').trim();
    await activityPersistence.clear(serverId || undefined);
    // Intentionally clears only activity fetch cache/state.
    // User-hidden activity items are renderer-owned localStorage preferences and must survive this call.

    if (serverId) {
        activityStateStore.delete(serverId);
    } else {
        activityStateStore.clear();
    }

    return {
        cleared: true,
        ...(await activityPersistence.getCacheStats(serverId || undefined)),
        serverId: serverId || undefined,
    };
}

export function handleActivityOpenItem(event: IpcMainInvokeEvent, payload: {postId?: string; threadId?: string; channelId?: string}) {
    const targetView = ViewManager.getViewByWebContentsId(event.sender.id) || ViewManager.getCurrentView();
    log.info('openItem request', {
        senderId: event.sender.id,
        hasPostId: Boolean(payload.postId),
        hasThreadId: Boolean(payload.threadId),
        hasChannelId: Boolean(payload.channelId),
    });
    if (!targetView) {
        return false;
    }

    const teamPrefix = getCurrentTeamPathPrefix(targetView);

    if (payload.postId) {
        const path = teamPrefix ? `${teamPrefix}/pl/${payload.postId}` : `/pl/${payload.postId}`;
        targetView.sendToRenderer(BROWSER_HISTORY_PUSH, path);
        return true;
    }

    if (payload.threadId) {
        targetView.sendToRenderer(BROWSER_HISTORY_PUSH, `/thread/${payload.threadId}`);
        return true;
    }

    if (payload.channelId) {
        targetView.sendToRenderer(BROWSER_HISTORY_PUSH, `/channels/${payload.channelId}`);
        return true;
    }

    return false;
}
export function handleActivityOpenSidebar() {
    MainWindow.sendToRenderer(ACTIVITY_SELECT_TAB);
    sendActivityActiveToView(true);
}

export function handleActivitySidebarDeactivated() {
    MainWindow.sendToRenderer(ACTIVITY_CLOSE_TAB);
}

export function handleActivitySetVisible(_: IpcMainEvent, isVisible: boolean) {
    syncActivityVisibility(isVisible).catch(() => {
        // keep UI responsive even if sidebar measurement fails
    });
}

async function syncActivityVisibility(isVisible: boolean) {
    const mainWindow = MainWindow.get();
    const currentView = ViewManager.getCurrentView();
    if (!mainWindow || !currentView) {
        return;
    }

    setActivitySidebarOpen(isVisible);
    const hasBackBar = currentView.currentURL ? shouldHaveBackBar(currentView.view.url || '', currentView.currentURL) : false;
    const bounds = getActivityViewBounds(mainWindow, hasBackBar);
    currentView.setBounds(bounds);

    sendActivityActiveToView(isVisible);
}

function sendActivityActiveToView(isActive: boolean) {
    const currentView = ViewManager.getCurrentView();
    if (currentView) {
        currentView.sendToRenderer(ACTIVITY_SIDEBAR_ACTIVE, isActive);
    }
}

