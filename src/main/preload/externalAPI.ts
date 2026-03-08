// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {IpcRendererEvent} from 'electron';
import {contextBridge, ipcRenderer, webFrame} from 'electron';

import type {DesktopAPI} from '@mattermost/desktop-api';

import {
    NOTIFY_MENTION,
    IS_UNREAD,
    UNREAD_RESULT,
    SESSION_EXPIRED,
    REACT_APP_INITIALIZED,
    USER_ACTIVITY_UPDATE,
    BROWSER_HISTORY_PUSH,
    APP_LOGGED_IN,
    APP_LOGGED_OUT,
    GET_VIEW_INFO_FOR_TEST,
    DESKTOP_SOURCES_RESULT,
    VIEW_FINISHED_RESIZING,
    CALLS_JOIN_CALL,
    CALLS_JOINED_CALL,
    CALLS_LEAVE_CALL,
    DESKTOP_SOURCES_MODAL_REQUEST,
    CALLS_WIDGET_SHARE_SCREEN,
    CALLS_ERROR,
    CALLS_JOIN_REQUEST,
    GET_IS_DEV_MODE,
    TOGGLE_SECURE_INPUT,
    GET_APP_INFO,
    REQUEST_BROWSER_HISTORY_STATUS,
    BROWSER_HISTORY_STATUS_UPDATED,
    NOTIFICATION_CLICKED,
    CALLS_WIDGET_RESIZE,
    CALLS_WIDGET_CHANNEL_LINK_CLICK,
    CALLS_LINK_CLICK,
    CALLS_POPOUT_FOCUS,
    CALLS_WIDGET_OPEN_THREAD,
    CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL,
    CALLS_WIDGET_OPEN_USER_SETTINGS,
    GET_DESKTOP_SOURCES,
    UNREADS_AND_MENTIONS,
    LEGACY_OFF,
    TAB_LOGIN_CHANGED,
    GET_DEVELOPER_MODE_SETTING,
    METRICS_SEND,
    METRICS_REQUEST,
    METRICS_RECEIVE,
    ACTIVITY_GET_SNAPSHOT,
    ACTIVITY_OPEN_SIDEBAR,
    ACTIVITY_LOAD_OLDER,
    ACTIVITY_REFRESH,
    ACTIVITY_SEARCH_LOCAL,
    ACTIVITY_OPEN_ITEM,
    ACTIVITY_CACHE_STATS,
    ACTIVITY_CACHE_CLEAR,
    ACTIVITY_SIDEBAR_ACTIVE,
    ACTIVITY_SIDEBAR_DEACTIVATED,
} from 'common/communication';

import type {ExternalAPI} from 'types/externalAPI';

const ACTIVITY_DEMO_BLUR = ['1', 'true', 'on', 'yes'].includes((process.env.MM_DESKTOP_ACTIVITY_DEMO_BLUR || '').toLowerCase());

const ACTIVITY_DEBUG_KEYWORDS = /(mentions|reactions|threads|reminders)/i;

function shouldTraceActivityAPI(url: string) {
    return url.includes('/api/v4/') && ACTIVITY_DEBUG_KEYWORDS.test(url);
}

function installActivityAPIDebugProbe() {
    const tracedWindow = window as Window & {__activityApiDebugProbeInstalled?: boolean};
    if (tracedWindow.__activityApiDebugProbeInstalled) {
        return;
    }
    tracedWindow.__activityApiDebugProbeInstalled = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = (init?.method || 'GET').toUpperCase();
        const response = await originalFetch(input, init);
        if (shouldTraceActivityAPI(url)) {
            console.info('[ActivityAPIDebug][fetch]', {method, url, status: response.status});
        }
        return response;
    }) as typeof window.fetch;

    type TracedXHR = XMLHttpRequest & {
        __activityTraceUrl?: string;
        __activityTraceMethod?: string;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null,
    ) {
        const traced = this as TracedXHR;
        traced.__activityTraceMethod = method.toUpperCase();
        traced.__activityTraceUrl = typeof url === 'string' ? url : url.toString();
        return originalOpen.call(this, method, url, async ?? true, username, password);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const traced = this as TracedXHR;
        this.addEventListener('loadend', () => {
            const url = traced.__activityTraceUrl || '';
            if (shouldTraceActivityAPI(url)) {
                console.info('[ActivityAPIDebug][xhr]', {
                    method: traced.__activityTraceMethod || 'GET',
                    url,
                    status: this.status,
                });
            }
        }, {once: true});
        return originalSend.call(this, body);
    };
}

installActivityAPIDebugProbe();

type ActivityCacheDebugAPI = {
    stats: (serverId?: string) => Promise<{
        rootPath: string;
        stateBytes: number;
        snapshotBytes: number;
        totalBytes: number;
        stateFiles: number;
        snapshotFiles: number;
        serverId?: string;
    }>;
    clear: (serverId?: string) => Promise<{
        cleared: boolean;
        rootPath: string;
        stateBytes: number;
        snapshotBytes: number;
        totalBytes: number;
        stateFiles: number;
        snapshotFiles: number;
        serverId?: string;
    }>;
    help: () => void;
};

function installActivityCacheDebugBridge() {
    const api: ActivityCacheDebugAPI = {
        stats: (serverId?: string) => ipcRenderer.invoke(ACTIVITY_CACHE_STATS, {serverId}),
        clear: (serverId?: string) => ipcRenderer.invoke(ACTIVITY_CACHE_CLEAR, {serverId}),
        help: () => {
            console.info('[ActivityCacheDebug] usage:');
            console.info('  await window.__activityCacheDebug.stats()');
            console.info('  await window.__activityCacheDebug.clear()');
            console.info('  await window.__activityCacheDebug.stats("<serverId>")');
            console.info('  await window.__activityCacheDebug.clear("<serverId>")');
            console.info('  note: clear() resets activity cache only; hidden-item preferences are preserved');
        },
    };

    try {
        contextBridge.exposeInMainWorld('__activityCacheDebug', api);
        return;
    } catch {
        // Ignore re-expose errors in dev hot reload.
    }

    const fallbackWindow = window as Window & {__activityCacheDebug?: ActivityCacheDebugAPI};
    if (!fallbackWindow.__activityCacheDebug) {
        fallbackWindow.__activityCacheDebug = api;
    }
}

installActivityCacheDebugBridge();

let legacyEnabled = false;
let legacyOff: () => void;

ipcRenderer.invoke(GET_DEVELOPER_MODE_SETTING, 'forceLegacyAPI').then((force) => {
    if (force) {
        return;
    }

    const createListener: ExternalAPI['createListener'] = (channel: string, listener: (...args: never[]) => void) => {
        const listenerWithEvent = (_: IpcRendererEvent, ...args: unknown[]) =>
            listener(...args as never[]);
        ipcRenderer.on(channel, listenerWithEvent);
        return () => {
            ipcRenderer.off(channel, listenerWithEvent);
        };
    };

    const desktopAPI: DesktopAPI = {

        // Initialization
        isDev: () => ipcRenderer.invoke(GET_IS_DEV_MODE),
        getAppInfo: () => {
            // Using this signal as the sign to disable the legacy code, since it is run before the app is rendered
            if (legacyEnabled) {
                legacyOff?.();
            }

            return ipcRenderer.invoke(GET_APP_INFO);
        },
        reactAppInitialized: () => ipcRenderer.send(REACT_APP_INITIALIZED),

        // Session
        setSessionExpired: (isExpired) => ipcRenderer.send(SESSION_EXPIRED, isExpired),
        onUserActivityUpdate: (listener) => createListener(USER_ACTIVITY_UPDATE, listener),

        onLogin: () => ipcRenderer.send(TAB_LOGIN_CHANGED, true),
        onLogout: () => ipcRenderer.send(TAB_LOGIN_CHANGED, false),

        // Unreads/mentions/notifications
        sendNotification: (title, body, channelId, teamId, url, silent, soundName) =>
            ipcRenderer.invoke(NOTIFY_MENTION, title, body, channelId, teamId, url, silent, soundName),
        onNotificationClicked: (listener) => createListener(NOTIFICATION_CLICKED, listener),
        setUnreadsAndMentions: (isUnread, mentionCount) => ipcRenderer.send(UNREADS_AND_MENTIONS, isUnread, mentionCount),

        // Navigation
        requestBrowserHistoryStatus: () => ipcRenderer.invoke(REQUEST_BROWSER_HISTORY_STATUS),
        onBrowserHistoryStatusUpdated: (listener) => createListener(BROWSER_HISTORY_STATUS_UPDATED, listener),
        onBrowserHistoryPush: (listener) => createListener(BROWSER_HISTORY_PUSH, listener),
        sendBrowserHistoryPush: (path) => ipcRenderer.send(BROWSER_HISTORY_PUSH, path),

        // Calls
        joinCall: (opts) => ipcRenderer.invoke(CALLS_JOIN_CALL, opts),
        leaveCall: () => ipcRenderer.send(CALLS_LEAVE_CALL),

        callsWidgetConnected: (callID, sessionID) => ipcRenderer.send(CALLS_JOINED_CALL, callID, sessionID),
        resizeCallsWidget: (width, height) => ipcRenderer.send(CALLS_WIDGET_RESIZE, width, height),

        sendCallsError: (err, callID, errMsg) => ipcRenderer.send(CALLS_ERROR, err, callID, errMsg),
        onCallsError: (listener) => createListener(CALLS_ERROR, listener),

        getDesktopSources: (opts) => ipcRenderer.invoke(GET_DESKTOP_SOURCES, opts),
        openScreenShareModal: () => ipcRenderer.send(DESKTOP_SOURCES_MODAL_REQUEST),
        onOpenScreenShareModal: (listener) => createListener(DESKTOP_SOURCES_MODAL_REQUEST, listener),

        shareScreen: (sourceID, withAudio) => ipcRenderer.send(CALLS_WIDGET_SHARE_SCREEN, sourceID, withAudio),
        onScreenShared: (listener) => createListener(CALLS_WIDGET_SHARE_SCREEN, listener),

        sendJoinCallRequest: (callId) => ipcRenderer.send(CALLS_JOIN_REQUEST, callId),
        onJoinCallRequest: (listener) => createListener(CALLS_JOIN_REQUEST, listener),

        openLinkFromCalls: (url) => ipcRenderer.send(CALLS_LINK_CLICK, url),

        focusPopout: () => ipcRenderer.send(CALLS_POPOUT_FOCUS),

        openThreadForCalls: (threadID) => ipcRenderer.send(CALLS_WIDGET_OPEN_THREAD, threadID),
        onOpenThreadForCalls: (listener) => createListener(CALLS_WIDGET_OPEN_THREAD, listener),

        openStopRecordingModal: (channelID) => ipcRenderer.send(CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL, channelID),
        onOpenStopRecordingModal: (listener) => createListener(CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL, listener),

        openCallsUserSettings: () => ipcRenderer.send(CALLS_WIDGET_OPEN_USER_SETTINGS),
        onOpenCallsUserSettings: (listener) => createListener(CALLS_WIDGET_OPEN_USER_SETTINGS, listener),

        onSendMetrics: (listener) => createListener(METRICS_SEND, listener),

        // Utility
        unregister: (channel) => ipcRenderer.removeAllListeners(channel),
    };
    contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);
});

ipcRenderer.on(METRICS_REQUEST, async (_, name, serverId) => {
    const memory = await process.getProcessMemoryInfo();
    ipcRenderer.send(METRICS_RECEIVE, name, {serverId, cpu: process.getCPUUsage().percentCPUUsage, memory: memory.residentSet ?? memory.private});
});

// Call this once to unset it to 0
process.getCPUUsage();

// Specific info for the testing environment
if (process.env.NODE_ENV === 'test') {
    contextBridge.exposeInMainWorld('testHelper', {
        getViewInfoForTest: () => ipcRenderer.invoke(GET_VIEW_INFO_FOR_TEST),
    });
}

/****************************************************************************
 * window/document listeners
 * These are here to perform specific tasks when global window or document events happen
 * Avoid using these unless absolutely necessary
 ****************************************************************************
 */

// Let the main process know when the window has finished resizing
// This is to reduce the amount of white box that happens when expand the BrowserView
window.addEventListener('resize', () => {
    ipcRenderer.send(VIEW_FINISHED_RESIZING);
});

// Enable secure input on macOS clients when the user is on a password input
let isPasswordBox = false;
const shouldSecureInput = (element: {tagName?: string; type?: string} | null, force = false) => {
    const targetIsPasswordBox = (element && element.tagName === 'INPUT' && element.type === 'password');
    if (targetIsPasswordBox && (!isPasswordBox || force)) {
        ipcRenderer.send(TOGGLE_SECURE_INPUT, true);
    } else if (!targetIsPasswordBox && (isPasswordBox || force)) {
        ipcRenderer.send(TOGGLE_SECURE_INPUT, false);
    }

    isPasswordBox = Boolean(targetIsPasswordBox);
};
window.addEventListener('focusin', (event) => {
    shouldSecureInput(event.target as Element);
});
window.addEventListener('focus', () => {
    shouldSecureInput(document.activeElement, true);
});

// exit fullscreen embedded elements like youtube - https://mattermost.atlassian.net/browse/MM-19226
ipcRenderer.on('exit-fullscreen', () => {
    if (document.fullscreenElement && document.fullscreenElement.nodeName.toLowerCase() === 'iframe') {
        document.exitFullscreen();
    }
});

// mattermost-webapp is SPA. So cache is not cleared due to no navigation.
// We needed to manually clear cache to free memory in long-term-use.
// http://seenaburns.com/debugging-electron-memory-usage/
const CLEAR_CACHE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
setInterval(() => {
    webFrame.clearCache();
}, CLEAR_CACHE_INTERVAL);

/**
 * Activity sidebar injection
 * Injects an "Activity" navigation item into the Mattermost web app sidebar,
 * positioned alongside Threads/Mentions/Drafts.
 */
const ACTIVITY_ITEM_ID = 'desktop-activity-sidebar-item';
const ACTIVITY_PANEL_ID = 'desktop-activity-content-panel';
const ACTIVITY_PANEL_STYLE_ID = 'desktop-activity-content-style';
const ACTIVITY_SVG_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 15H6L13 1V9H18L11 23V15Z" fill="currentColor"/></svg>';
const ACTIVITY_KIND_ICONS: Record<string, string> = {
    mention: 'icon-at',
    thread_reply: 'icon-reply-outline',
    reaction: 'icon-emoticon-plus-outline',
    dm: 'icon-account-outline',
    gm: 'icon-account-multiple-outline',
    reminder: 'icon-clock-outline',
};
const ACTIVITY_FILTER_KINDS = ['mention', 'thread_reply', 'reaction', 'dm', 'gm', 'reminder'] as const;
const ACTIVITY_FILTERS_STORAGE_KEY = 'mm-desktop-activity-filters-v1';
const ACTIVITY_HIDDEN_ITEMS_STORAGE_KEY = 'mm-desktop-activity-hidden-items-v1';

type ActivityPanelItem = {
    canonicalId: string;
    eventKind: string;
    eventTs: number;
    previewText?: string;
    reminderId?: string;
    actorAvatarUrl?: string;
    isUnread?: boolean;
    postId?: string;
    threadId?: string;
    channelId?: string;
    sourceRef?: Record<string, string>;
};

type ActivityPanelPage = {
    items: ActivityPanelItem[];
    errors?: Array<{source: string; message: string}>;
    hasMore?: boolean;
};

let activityItems: ActivityPanelItem[] = [];
let activityPanelLoading = false;
let activityPanelError = '';
let activityPanelHasMore = true;
let activityVisibleCount = 0;
let activityRenderTimer: ReturnType<typeof setTimeout> | null = null;
let activityRefreshInFlight: Promise<void> | null = null;
let activityLoadOlderInFlight: Promise<void> | null = null;
let activitySearchInFlight: Promise<void> | null = null;
let activityKindFilters: Record<string, boolean> = ACTIVITY_FILTER_KINDS.reduce<Record<string, boolean>>((acc, kind) => {
    acc[kind] = true;
    return acc;
}, {});
let activityHighlightedOnlyFilter = false;
let activityHideThreadItems = false;
let activityHideMentionReactionItems = false;
const activityLoadedAvatarKeys = new Set<string>();
let activityHiddenItemIds = new Set<string>();

const ACTIVITY_RENDER_BATCH_SIZE = 10;

type PersistedActivityFilters = {
    kindFilters?: Partial<Record<string, boolean>>;
    highlightedOnly?: boolean;
    hideThreadItems?: boolean;
    hideMentionReactionItems?: boolean;
};

function persistActivityFilters() {
    try {
        const payload: PersistedActivityFilters = {
            kindFilters: ACTIVITY_FILTER_KINDS.reduce<Partial<Record<string, boolean>>>((acc, kind) => {
                acc[kind] = isActivityKindEnabled(kind);
                return acc;
            }, {}),
            highlightedOnly: activityHighlightedOnlyFilter,
            hideThreadItems: activityHideThreadItems,
            hideMentionReactionItems: activityHideMentionReactionItems,
        };
        localStorage.setItem(ACTIVITY_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // Ignore persistence errors to keep panel interaction stable.
    }
}

function hydrateActivityFiltersFromStorage() {
    try {
        const raw = localStorage.getItem(ACTIVITY_FILTERS_STORAGE_KEY);
        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw) as PersistedActivityFilters;
        if (parsed.kindFilters) {
            ACTIVITY_FILTER_KINDS.forEach((kind) => {
                const value = parsed.kindFilters?.[kind];
                if (typeof value === 'boolean') {
                    activityKindFilters[kind] = value;
                }
            });
        }
        if (typeof parsed.highlightedOnly === 'boolean') {
            activityHighlightedOnlyFilter = parsed.highlightedOnly;
        }
        if (typeof parsed.hideThreadItems === 'boolean') {
            activityHideThreadItems = parsed.hideThreadItems;
        }
        if (typeof parsed.hideMentionReactionItems === 'boolean') {
            activityHideMentionReactionItems = parsed.hideMentionReactionItems;
        }
    } catch {
        // Ignore malformed persisted values.
    }
}

hydrateActivityFiltersFromStorage();

function getActivityPanelItemId(item: ActivityPanelItem): string {
    if (item.canonicalId) {
        return item.canonicalId;
    }

    if (item.reminderId) {
        return `reminder:${item.reminderId}`;
    }

    if (item.postId) {
        return `${item.eventKind || 'event'}:post:${item.postId}`;
    }

    if (item.threadId) {
        return `${item.eventKind || 'event'}:thread:${item.threadId}`;
    }

    if (item.channelId) {
        return `${item.eventKind || 'event'}:channel:${item.channelId}`;
    }

    return `${item.eventKind || 'event'}:ts:${String(item.eventTs || 0)}`;
}

function persistHiddenActivityItemIds() {
    try {
        localStorage.setItem(ACTIVITY_HIDDEN_ITEMS_STORAGE_KEY, JSON.stringify(Array.from(activityHiddenItemIds)));
    } catch {
        // Ignore persistence errors to keep panel interaction stable.
    }
}

function hydrateHiddenActivityItemIdsFromStorage() {
    try {
        const raw = localStorage.getItem(ACTIVITY_HIDDEN_ITEMS_STORAGE_KEY);
        if (!raw) {
            activityHiddenItemIds = new Set();
            return;
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            activityHiddenItemIds = new Set();
            return;
        }

        activityHiddenItemIds = new Set(parsed.filter((value) => typeof value === 'string'));
    } catch {
        activityHiddenItemIds = new Set();
    }
}

hydrateHiddenActivityItemIdsFromStorage();

function logActivityPanel(event: string, details?: Record<string, unknown>) {
    if (details) {
        console.log(`[ActivityPanel] ${event}`, details);
        return;
    }
    console.log(`[ActivityPanel] ${event}`);
}

function clearActivityRenderTimer() {
    if (activityRenderTimer) {
        clearTimeout(activityRenderTimer);
        activityRenderTimer = null;
    }
}

function scheduleProgressiveActivityRender() {
    clearActivityRenderTimer();
    if (activityVisibleCount >= activityItems.length) {
        return;
    }
    activityRenderTimer = setTimeout(() => {
        activityVisibleCount = Math.min(activityVisibleCount + ACTIVITY_RENDER_BATCH_SIZE, activityItems.length);
        renderActivityPanel();
        scheduleProgressiveActivityRender();
    }, 16);
}

function setActivityItems(nextItems: ActivityPanelItem[], progressive = false) {
    activityItems = nextItems;
    clearActivityRenderTimer();
    if (!activityItems.length) {
        activityVisibleCount = 0;
        return;
    }

    if (!progressive) {
        activityVisibleCount = activityItems.length;
        return;
    }

    activityVisibleCount = Math.min(ACTIVITY_RENDER_BATCH_SIZE, activityItems.length);
    scheduleProgressiveActivityRender();
}

function clearNativeSidebarSelection() {
    const sidebar = document.getElementById('sidebar-left');
    if (!sidebar) {
        return;
    }

    const activeNodes = sidebar.querySelectorAll('.active, .selected, [aria-current="page"]');
    activeNodes.forEach((node) => {
        const element = node as HTMLElement;
        if (element.closest(`#${ACTIVITY_ITEM_ID}`)) {
            return;
        }

        element.classList.remove('active', 'selected', 'current');
        if (element.getAttribute('aria-current') === 'page') {
            element.removeAttribute('aria-current');
        }
    });
}

function getSidebarItemContainerFromLink(link: HTMLElement): HTMLElement {
    return link.closest('li, div.SidebarNavItem, div[class*="sidebarItem"]') as HTMLElement || link;
}

function setSidebarSectionVisibilityByPath(pathFragment: string, hidden: boolean) {
    const sidebar = document.getElementById('sidebar-left');
    if (!sidebar) {
        return;
    }

    const links = sidebar.querySelectorAll<HTMLAnchorElement>(`a[href*="${pathFragment}"]`);
    links.forEach((link) => {
        if (link.closest(`#${ACTIVITY_ITEM_ID}`)) {
            return;
        }
        const container = getSidebarItemContainerFromLink(link);
        if (hidden) {
            container.style.display = 'none';
            return;
        }
        container.style.removeProperty('display');
    });
}

function applyNativeSidebarSectionVisibility() {
    setSidebarSectionVisibilityByPath('/threads', activityHideThreadItems);
    setSidebarSectionVisibilityByPath('/activity', activityHideMentionReactionItems);
}

function getActivityPanelLeft(): number {
    const sidebar = document.getElementById('sidebar-left');
    if (!sidebar) {
        return 380;
    }
    const rect = sidebar.getBoundingClientRect();
    return Math.max(240, Math.round(rect.width || 380));
}

function ensureActivityPanelStyle() {
    let style = document.getElementById(ACTIVITY_PANEL_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = ACTIVITY_PANEL_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = `
#${ACTIVITY_PANEL_ID} {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    left: var(--desktop-activity-left, 380px);
    background: var(--center-channel-bg, #fff);
    color: var(--center-channel-color, inherit);
    z-index: 1000;
    display: none;
    flex-direction: column;
    border-left: 1px solid rgba(61, 60, 64, 0.12);
}
#${ACTIVITY_PANEL_ID}.visible {
    display: flex;
}
.desktop-activity-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(61, 60, 64, 0.12);
}
.desktop-activity-header-left {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}
.desktop-activity-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1;
}
.desktop-activity-header-toggles {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: rgba(63, 67, 80, 0.84);
    line-height: 1;
    margin: 0;
}
.desktop-activity-header-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    cursor: pointer;
    line-height: 1;
    margin: 0;
}
.desktop-activity-header-toggle input {
    margin: 0;
    cursor: pointer;
    flex-shrink: 0;
    width: 14px;
    min-height: 14px;
    max-height: 14px;
    accent-color: var(--button-bg, #166de0);
    align-self: center;
}
.desktop-activity-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
}
.desktop-activity-actions button {
    border: none;
    background: transparent;
    border-radius: 4px;
    height: 34px;
    width: 34px;
    padding: 0;
    color: rgba(63, 67, 80, 0.88);
    font-size: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}
.desktop-activity-actions button i {
    font-size: 22px;
    line-height: 1;
}
.desktop-activity-actions button:hover {
    background-color: rgba(63, 67, 80, 0.08);
    color: rgba(63, 67, 80, 1);
}
.desktop-activity-actions button:disabled {
    opacity: 0.4;
    cursor: default;
}
.desktop-activity-search-row button {
    border: 1px solid rgba(61, 60, 64, 0.16);
    background: transparent;
    border-radius: 4px;
    height: 28px;
    padding: 0 10px;
    cursor: pointer;
}
.desktop-activity-search {
    padding: 8px 16px;
    border-bottom: 1px solid rgba(61, 60, 64, 0.08);
}
.desktop-activity-search-row {
    display: flex;
    gap: 8px;
    align-items: center;
}
.desktop-activity-search-row input {
    flex: 1;
    min-width: 0;
    border: 1px solid rgba(61, 60, 64, 0.16);
    border-radius: 4px;
    height: 28px;
    padding: 0 8px;
    background: transparent;
    color: inherit;
}
.desktop-activity-filters {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    overflow-x: auto;
    white-space: nowrap;
    padding-bottom: 2px;
}
.desktop-activity-highlight-filter {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(63, 67, 80, 0.84);
    white-space: nowrap;
}
.desktop-activity-highlight-filter input {
    margin: 0;
    cursor: pointer;
}
.desktop-activity-highlight-filter-label {
    cursor: pointer;
}
.desktop-activity-filter-btn {
    border: 1px solid rgba(61, 60, 64, 0.2);
    background: transparent;
    border-radius: 12px;
    height: 24px;
    min-width: 24px;
    padding: 0 8px;
    cursor: pointer;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    color: rgba(63, 67, 80, 0.78);
}
.desktop-activity-filter-btn.is-active {
    background: rgba(22, 109, 224, 0.12);
    border-color: rgba(22, 109, 224, 0.32);
    color: rgba(22, 109, 224, 1);
}
.desktop-activity-filter-btn--all {
    font-weight: 600;
}
.desktop-activity-feed {
    overflow: auto;
    flex: 1;
}
.desktop-activity-load-more {
    border: 1px solid rgba(61, 60, 64, 0.16);
    background: transparent;
    border-radius: 4px;
    height: 30px;
    padding: 0 14px;
    cursor: pointer;
    color: var(--button-bg, #166de0);
    font-weight: 600;
}
.desktop-activity-load-more:disabled {
    opacity: 0.45;
    cursor: default;
}
.desktop-activity-load-more-row {
    display: flex;
    justify-content: center;
}
.desktop-activity-day-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px 16px 10px;
}
.desktop-activity-day-separator-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.2px;
    color: rgba(255, 255, 255, 0.96);
    background: rgba(20, 22, 28, 0.92);
    border: 1px solid rgba(20, 22, 28, 0.98);
}
.desktop-activity-item {
    border-bottom: 1px solid rgba(61, 60, 64, 0.08);
    padding: 10px 16px;
}
.desktop-activity-item--reminder {
    background: #ffe6e8 !important;
    border-left: 3px solid #d24b4e;
    padding-left: 13px;
}
.desktop-activity-item[data-kind="reminder"] {
    background: #ffe6e8 !important;
    border-left: 3px solid #d24b4e;
    padding-left: 13px;
}
.desktop-activity-item[data-kind="reminder"] .desktop-activity-item-body {
    background: #ffe6e8 !important;
}
.desktop-activity-item--reminder .desktop-activity-item-clickable:hover {
    background: rgba(210, 75, 78, 0.12);
}
.desktop-activity-item[data-kind="reminder"] .desktop-activity-item-clickable:hover {
    background: rgba(210, 75, 78, 0.12);
}
.desktop-activity-item[data-kind="gm"] {
    background: #fff8df;
    border-left: 3px solid #d2ad3d;
    padding-left: 13px;
}
.desktop-activity-item[data-kind="gm"] .desktop-activity-item-body {
    background: #fff8df;
}
.desktop-activity-item[data-kind="gm"] .desktop-activity-item-clickable:hover {
    background: rgba(210, 173, 61, 0.14);
}
.desktop-activity-item[data-kind="dm"] {
    background: #e9f8ee;
    border-left: 3px solid #3aa868;
    padding-left: 13px;
}
.desktop-activity-item[data-kind="dm"] .desktop-activity-item-body {
    background: #e9f8ee;
}
.desktop-activity-item[data-kind="dm"] .desktop-activity-item-clickable:hover {
    background: rgba(58, 168, 104, 0.14);
}
.desktop-activity-item--mention-personal {
    background: #e9f8ee;
    border-left: 3px solid #3aa868;
    padding-left: 13px;
}
.desktop-activity-item--mention-personal .desktop-activity-item-body {
    background: #e9f8ee;
}
.desktop-activity-item--mention-personal .desktop-activity-item-clickable:hover {
    background: rgba(58, 168, 104, 0.14);
}
.desktop-activity-item--mention-broadcast {
    background: #fff8df;
    border-left: 3px solid #d2ad3d;
    padding-left: 13px;
}
.desktop-activity-item--mention-broadcast .desktop-activity-item-body {
    background: #fff8df;
}
.desktop-activity-item--mention-broadcast .desktop-activity-item-clickable:hover {
    background: rgba(210, 173, 61, 0.14);
}
.desktop-activity-item-clickable {
    cursor: pointer;
}
.desktop-activity-item-clickable:hover {
    background: rgba(63, 67, 80, 0.04);
}
.desktop-activity-item-body {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.desktop-activity-avatar-slot {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
    margin-top: 2px;
    background: rgba(63, 67, 80, 0.1);
    overflow: hidden;
}
.desktop-activity-avatar {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    z-index: 2;
}
.desktop-activity-avatar--visible {
    opacity: 1;
}
.desktop-activity-avatar-fallback {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
    color: rgba(63, 67, 80, 0.68);
    font-size: 18px;
}
.desktop-activity-item-content {
    flex: 1;
    min-width: 0;
}
.desktop-activity-title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 3px;
    min-width: 0;
}
.desktop-activity-item-meta {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
    margin-left: auto;
    flex: 1 1 auto;
    overflow: hidden;
}
.desktop-activity-item-time {
    flex-shrink: 0;
    white-space: nowrap;
    font-size: 12px;
    color: rgba(63, 67, 80, 0.56);
}
.desktop-activity-item-hide {
    border: none;
    background: transparent;
    color: var(--error-text, #d24b4e);
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transform: translateY(-1px);
}
.desktop-activity-item-hide:hover {
    background: rgba(210, 75, 78, 0.15);
    color: var(--error-text, #d24b4e);
}
.desktop-activity-item-hide:focus-visible {
    outline: 2px solid rgba(22, 109, 224, 0.45);
    outline-offset: 1px;
}
.desktop-activity-unread-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3aa868;
    display: inline-block;
    flex-shrink: 0;
}
.desktop-activity-actor {
    border: none;
    background: none;
    color: inherit;
    padding: 0;
    margin: 0;
    text-align: left;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
    flex: 0 1 auto;
    min-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.desktop-activity-debug-key {
    display: inline-block;
    max-width: 100%;
    margin-left: 6px;
    font-family: Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 10px;
    font-weight: 400;
    opacity: 0.65;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.desktop-activity-kind {
    font-size: 14px;
    color: rgba(63, 67, 80, 0.72);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
}
.desktop-activity-preview {
    font-size: 14px;
    line-height: 20px;
    margin: 0;
}
.desktop-activity-message {
    font-size: 14px;
    line-height: 20px;
    margin-top: 0;
    white-space: normal;
}
.desktop-activity-reaction {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.desktop-activity-reaction-emoji {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex-shrink: 0;
    vertical-align: middle;
}
.desktop-activity-reaction-shortcode {
    display: none;
}
.desktop-activity-preview a,
.desktop-activity-message a {
    color: var(--button-bg, #166de0);
    text-decoration: none;
}
.desktop-activity-preview a:hover,
.desktop-activity-message a:hover {
    text-decoration: underline;
}
.desktop-activity-preview code,
.desktop-activity-message code {
    font-family: Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(63, 67, 80, 0.1);
}
.desktop-activity-preview ul,
.desktop-activity-preview ol,
.desktop-activity-message ul,
.desktop-activity-message ol {
    margin: 6px 0 6px 18px;
    padding: 0;
}
.desktop-activity-preview li,
.desktop-activity-message li {
    margin: 2px 0;
}
.desktop-activity-actor strong {
    color: inherit;
    font-weight: 600;
}
.desktop-activity-gm-meta {
    font-size: 12px;
    margin-right: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    word-break: normal;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    text-align: right;
    padding: 2px 8px;
    border-radius: 12px;
    background: rgba(63, 67, 80, 0.12);
    opacity: 1;
    min-width: 0;
    flex-shrink: 1;
}
.desktop-activity-channel-meta {
    font-size: 12px;
    margin-right: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    word-break: normal;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    text-align: right;
    padding: 2px 8px;
    border-radius: 12px;
    background: rgba(63, 67, 80, 0.12);
    opacity: 1;
    min-width: 0;
    flex-shrink: 1;
}
.desktop-activity-open {
    border: none;
    background: none;
    color: var(--button-bg, #166de0);
    padding: 0;
    cursor: pointer;
}
.desktop-activity-empty,
.desktop-activity-error,
.desktop-activity-loading {
    padding: 12px 16px;
    font-size: 13px;
}
.desktop-activity-error {
    color: var(--error-text, #d24b4e);
}
${ACTIVITY_DEMO_BLUR ? `
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-avatar-slot,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-avatar,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-avatar-fallback,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-actor,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-gm-meta,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-channel-meta,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-preview,
#${ACTIVITY_PANEL_ID}.activity-demo-blur .desktop-activity-message {
    filter: blur(4px);
    user-select: none;
}
#desktop-activity-demo-blur-overlay {
    position: fixed;
    inset: 0;
    z-index: 999;
    pointer-events: none;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
#${ACTIVITY_ITEM_ID} {
    position: relative;
    z-index: 1000;
}
` : ''}
`;
}

function ensureActivityPanel() {
    ensureActivityPanelStyle();
    let panel = document.getElementById(ACTIVITY_PANEL_ID);
    if (panel) {
        return panel;
    }

    panel = document.createElement('section');
    panel.id = ACTIVITY_PANEL_ID;
    if (ACTIVITY_DEMO_BLUR) {
        panel.classList.add('activity-demo-blur');
    }
    panel.innerHTML = `
<div class="desktop-activity-header">
  <div class="desktop-activity-header-left">
    <h2 class="desktop-activity-title">Activity</h2>
    <div class="desktop-activity-header-toggles">
      <label class="desktop-activity-header-toggle">
        <input data-role="hide-threads" data-action="toggle-hide-threads" type="checkbox" ${!activityHideThreadItems ? 'checked' : ''}/>
        <span>Threads</span>
      </label>
      <label class="desktop-activity-header-toggle">
        <input data-role="hide-mentions-reactions" data-action="toggle-hide-mentions-reactions" type="checkbox" ${!activityHideMentionReactionItems ? 'checked' : ''}/>
        <span>Mentions + Reactions</span>
      </label>
    </div>
  </div>
  <div class="desktop-activity-actions">
    <button data-action="refresh" type="button" aria-label="Refresh" title="Refresh"><i class="icon icon-refresh" aria-hidden="true"></i></button>
    <button data-action="close" type="button" aria-label="Close" title="Close"><i class="icon icon-close" aria-hidden="true"></i></button>
  </div>
</div>
<div class="desktop-activity-search">
  <div class="desktop-activity-search-row">
    <input data-role="query" type="text" placeholder="Filter activity..." />
    <button data-action="search-local" type="button">Filter</button>
    <div class="desktop-activity-filters" data-role="filters">${renderFilterButtonsHtml()}</div>
    <label class="desktop-activity-highlight-filter" title="Show only important activity">
      <input data-role="highlighted-only" data-action="toggle-highlighted-only" type="checkbox" ${activityHighlightedOnlyFilter ? 'checked' : ''}/>
      <span class="desktop-activity-highlight-filter-label">Important</span>
    </label>
  </div>
</div>
<div class="desktop-activity-feed" data-role="feed"></div>
`;

    const queryInput = panel.querySelector<HTMLInputElement>('[data-role="query"]');
    const highlightedOnlyInput = panel.querySelector<HTMLInputElement>('[data-role="highlighted-only"]');
    const hideThreadsInput = panel.querySelector<HTMLInputElement>('[data-role="hide-threads"]');
    const hideMentionsReactionsInput = panel.querySelector<HTMLInputElement>('[data-role="hide-mentions-reactions"]');
    if (highlightedOnlyInput) {
        highlightedOnlyInput.checked = activityHighlightedOnlyFilter;
    }
    if (hideThreadsInput) {
        hideThreadsInput.checked = !activityHideThreadItems;
    }
    if (hideMentionsReactionsInput) {
        hideMentionsReactionsInput.checked = !activityHideMentionReactionItems;
    }
    queryInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();

            const query = (queryInput.value || '').trim();
            if (query) {
                queryInput.value = '';
                logActivityPanel('search_escape_cleared');
                return;
            }

            logActivityPanel('search_escape_empty_reset');
            refreshActivityPanel(true).catch(() => {
                // ignore interaction errors
            });
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();

            const query = (queryInput.value || '').trim();
            if (!query) {
                logActivityPanel('search_enter_empty_query_refresh');
                refreshActivityPanel(true).catch(() => {
                    // ignore interaction errors
                });
                return;
            }

            logActivityPanel('search_enter_apply', {query});
            searchActivityPanel().catch(() => {
                // ignore interaction errors
            });
        }
    });

    panel.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        const actionElement = target?.closest<HTMLElement>('[data-action]');
        const action = actionElement?.dataset.action;
        if (!action) {
            return;
        }

        if (action === 'close') {
            logActivityPanel('close_click');
            setActivityItemActive(false);
            ipcRenderer.send(ACTIVITY_SIDEBAR_DEACTIVATED);
            return;
        }

        if (action === 'refresh') {
            logActivityPanel('refresh_click');
            refreshActivityPanel().catch(() => {
                // ignore interaction errors
            });
            return;
        }

        if (action === 'load-older') {
            logActivityPanel('load_older_click');
            loadOlderActivityPanel().catch(() => {
                // ignore interaction errors
            });
            return;
        }

        if (action === 'search-local') {
            logActivityPanel('search_local_click');
            queryInput?.focus();
            return;
        }

        if (action === 'toggle-filter-all') {
            const allEnabled = ACTIVITY_FILTER_KINDS.every((kind) => isActivityKindEnabled(kind));
            ACTIVITY_FILTER_KINDS.forEach((kind) => {
                activityKindFilters[kind] = !allEnabled;
            });
            persistActivityFilters();
            renderActivityPanel();
            return;
        }

        if (action === 'toggle-filter') {
            const kind = actionElement?.dataset.kind;
            if (!kind || !ACTIVITY_FILTER_KINDS.includes(kind as typeof ACTIVITY_FILTER_KINDS[number])) {
                return;
            }
            activityKindFilters[kind] = !isActivityKindEnabled(kind);
            persistActivityFilters();
            renderActivityPanel();
            return;
        }

        if (action === 'toggle-highlighted-only') {
            activityHighlightedOnlyFilter = !activityHighlightedOnlyFilter;
            persistActivityFilters();
            renderActivityPanel();
            return;
        }

        if (action === 'toggle-hide-threads') {
            const isChecked = actionElement instanceof HTMLInputElement ? actionElement.checked : !activityHideThreadItems;
            activityHideThreadItems = !isChecked;
            persistActivityFilters();
            applyNativeSidebarSectionVisibility();
            renderActivityPanel();
            return;
        }

        if (action === 'toggle-hide-mentions-reactions') {
            const isChecked = actionElement instanceof HTMLInputElement ? actionElement.checked : !activityHideMentionReactionItems;
            activityHideMentionReactionItems = !isChecked;
            persistActivityFilters();
            applyNativeSidebarSectionVisibility();
            renderActivityPanel();
            return;
        }

        if (action === 'open-item') {
            const button = actionElement.closest<HTMLElement>('[data-post-id], [data-thread-id], [data-channel-id]') || actionElement;
            logActivityPanel('open_item_click', {
                postId: button?.dataset.postId,
                threadId: button?.dataset.threadId,
                channelId: button?.dataset.channelId,
            });
            ipcRenderer.invoke(ACTIVITY_OPEN_ITEM, {
                postId: button?.dataset.postId,
                threadId: button?.dataset.threadId,
                channelId: button?.dataset.channelId,
            }).catch(() => {
                // ignore interaction errors
            });
            return;
        }

        if (action === 'hide-item') {
            const itemId = (actionElement.dataset.itemId || '').trim();
            if (!itemId) {
                return;
            }
            activityHiddenItemIds.add(itemId);
            persistHiddenActivityItemIds();
            renderActivityPanel();
        }
    });

    document.body.appendChild(panel);
    return panel;
}

function updateActivityPanelPosition() {
    const panel = ensureActivityPanel();
    panel.style.setProperty('--desktop-activity-left', `${getActivityPanelLeft()}px`);
}

function formatActivityTime(ts: number) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const now = new Date();
    const isToday = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

    if (isToday) {
        return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    }

    return date.toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function isSameLocalDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function toLocalDayKey(date: Date) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getActivityDayBadgeLabel(ts: number) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const now = new Date();
    if (isSameLocalDay(date, now)) {
        return 'Today';
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameLocalDay(date, yesterday)) {
        return 'Yesterday';
    }

    return toLocalDayKey(date);
}

function escapeHtml(value: string) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeActivityLinkUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
        return trimmed;
    }

    try {
        const parsed = new URL(trimmed, 'https://mattermost.local');
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
            return trimmed;
        }
    } catch {
        return '';
    }

    return '';
}

function renderActivityInlineMarkdown(value: string) {
    let html = escapeHtml(value);

    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    html = html.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');

    return html;
}

function splitTrailingUrlPunctuation(url: string) {
    let core = url;
    let trailing = '';
    while (/[),.!?;:]$/.test(core)) {
        trailing = core.slice(-1) + trailing;
        core = core.slice(0, -1);
    }
    return {core, trailing};
}

function renderActivityInlineMarkdownWithAutoLinks(value: string) {
    const autoLinkPattern = /\bhttps?:\/\/[^\s<>"'`]+/g;
    let html = '';
    let cursor = 0;
    let match = autoLinkPattern.exec(value);

    while (match) {
        html += renderActivityInlineMarkdown(value.slice(cursor, match.index));

        const {core, trailing} = splitTrailingUrlPunctuation(match[0]);
        const safeUrl = sanitizeActivityLinkUrl(core);
        if (safeUrl) {
            html += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(core)}</a>`;
            html += renderActivityInlineMarkdown(trailing);
        } else {
            html += renderActivityInlineMarkdown(match[0]);
        }

        cursor = match.index + match[0].length;
        match = autoLinkPattern.exec(value);
    }

    html += renderActivityInlineMarkdown(value.slice(cursor));
    return html;
}

function renderActivityInlineMarkdownWithLinks(value: string) {
    const linkPattern = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    let html = '';
    let cursor = 0;
    let match = linkPattern.exec(value);

    while (match) {
        html += renderActivityInlineMarkdownWithAutoLinks(value.slice(cursor, match.index));

        const linkText = match[1];
        const safeUrl = sanitizeActivityLinkUrl(match[2]);
        if (safeUrl) {
            html += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${renderActivityInlineMarkdown(linkText)}</a>`;
        } else {
            html += renderActivityInlineMarkdownWithAutoLinks(match[0]);
        }

        cursor = match.index + match[0].length;
        match = linkPattern.exec(value);
    }

    html += renderActivityInlineMarkdownWithAutoLinks(value.slice(cursor));
    return html;
}

function renderActivityMarkdown(value: string) {
    const lines = value.split(/\r?\n/);
    const blocks: string[] = [];
    const paragraphLines: string[] = [];
    const listItems: string[] = [];
    let listType: 'ul' | 'ol' | null = null;

    const flushParagraph = () => {
        if (!paragraphLines.length) {
            return;
        }
        blocks.push(renderActivityInlineMarkdownWithLinks(paragraphLines.join('\n')).replace(/\n/g, '<br/>'));
        paragraphLines.length = 0;
    };

    const flushList = () => {
        if (!listType || !listItems.length) {
            return;
        }
        const itemsHtml = listItems.map((item) => `<li>${renderActivityInlineMarkdownWithLinks(item)}</li>`).join('');
        blocks.push(`<${listType}>${itemsHtml}</${listType}>`);
        listItems.length = 0;
        listType = null;
    };

    for (const line of lines) {
        const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
        const bulletMatch = line.match(/^\s*[-+*]\s+(.+)$/);
        const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);

        if (headingMatch) {
            flushParagraph();
            flushList();
            blocks.push(`<strong>${renderActivityInlineMarkdownWithLinks(headingMatch[1])}</strong>`);
            continue;
        }

        if (bulletMatch) {
            flushParagraph();
            if (listType !== 'ul') {
                flushList();
                listType = 'ul';
            }
            listItems.push(bulletMatch[1]);
            continue;
        }

        if (orderedMatch) {
            flushParagraph();
            if (listType !== 'ol') {
                flushList();
                listType = 'ol';
            }
            listItems.push(orderedMatch[1]);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            flushList();
            continue;
        }

        flushList();
        paragraphLines.push(line);
    }

    flushParagraph();
    flushList();

    return blocks.join('');
}

function getActivityActorName(item: ActivityPanelItem) {
    const actorFromSource = (item.sourceRef?.actorName || '').trim();
    if (actorFromSource) {
        return actorFromSource;
    }

    if (item.eventKind !== 'dm' && item.eventKind !== 'gm') {
        return '';
    }

    const preview = (item.previewText || '').trim();
    const separatorIndex = preview.indexOf(':');
    if (separatorIndex > 0) {
        return preview.slice(0, separatorIndex).trim();
    }
    return '';
}

function getActivityMessage(item: ActivityPanelItem, actorName: string) {
    const preview = (item.previewText || '').trim();
    if (!preview) {
        return (item.sourceRef?.linkUrl || '').trim();
    }

    const isDmOrGm = item.eventKind === 'dm' || item.eventKind === 'gm';
    if (!isDmOrGm) {
        return preview;
    }

    if (actorName && preview.startsWith(`${actorName}:`)) {
        return preview.slice(actorName.length + 1).trim();
    }

    const separatorIndex = preview.indexOf(':');
    if (separatorIndex > 0) {
        return preview.slice(separatorIndex + 1).trim();
    }

    return preview;
}

function getReactionMessageHtml(item: ActivityPanelItem, fallbackText: string) {
    const emojiName = (item.sourceRef?.emoji || '').trim();
    if (!emojiName) {
        return renderActivityMarkdown(fallbackText || '(no preview)');
    }

    const emojiShortcode = `:${emojiName}:`;
    const unicodeFallback = (item.sourceRef?.emojiUnicode || '').trim();
    const fallbackLabel = unicodeFallback || fallbackText || emojiShortcode;
    const emojiImageUrl = sanitizeActivityLinkUrl((item.sourceRef?.emojiImageUrl || '').trim());
    if (!emojiImageUrl) {
        return renderActivityMarkdown(fallbackLabel);
    }

    return `<span class="desktop-activity-reaction"><img class="desktop-activity-reaction-emoji" src="${escapeHtml(emojiImageUrl)}" alt="${escapeHtml(emojiShortcode)}" loading="lazy" onerror="this.style.display='none'; const fallback = this.nextElementSibling; if (fallback) { fallback.style.display = 'inline'; }"/><span class="desktop-activity-reaction-shortcode">${escapeHtml(fallbackLabel)}</span></span>`;
}

function getActivityAvatarHtml(item: ActivityPanelItem) {
    const rawUrl = (item.actorAvatarUrl || '').trim();
    const iconClass = ACTIVITY_KIND_ICONS[item.eventKind] || 'icon-account-outline';
    const avatarKey = `${item.canonicalId}:${rawUrl}`;
    const visibilityClass = activityLoadedAvatarKeys.has(avatarKey) ? ' desktop-activity-avatar--visible' : '';
    const imgHtml = rawUrl ?
        `<img class="desktop-activity-avatar${visibilityClass}" data-avatar-key="${escapeHtml(avatarKey)}" src="${escapeHtml(rawUrl)}" alt="" loading="lazy" onload="this.classList.add('desktop-activity-avatar--visible')" onerror="this.remove()"/>` :
        '';
    return `<span class="desktop-activity-avatar-slot">${imgHtml}<span class="desktop-activity-avatar-fallback"><i class="icon ${iconClass}" aria-hidden="true"></i></span></span>`;
}

function markActivityAvatarAsLoaded(img: HTMLImageElement) {
    const avatarKey = img.dataset.avatarKey;
    if (avatarKey) {
        activityLoadedAvatarKeys.add(avatarKey);
    }
    img.classList.add('desktop-activity-avatar--visible');
}

function wireActivityAvatarImages(feed: HTMLElement) {
    const avatarImages = feed.querySelectorAll<HTMLImageElement>('img[data-avatar-key]');
    avatarImages.forEach((img) => {
        if (img.complete && img.naturalWidth > 0) {
            markActivityAvatarAsLoaded(img);
            return;
        }
        img.addEventListener('load', () => markActivityAvatarAsLoaded(img), {once: true});
    });
}

function getActivityKindLabel(eventKind: string) {
    return eventKind.
        split('_').
        map((part) => part.charAt(0).toUpperCase() + part.slice(1)).
        join(' ');
}

function getActivityTitle(item: ActivityPanelItem, actorName: string) {
    if (actorName) {
        return actorName;
    }
    if (item.eventKind === 'dm') {
        return 'Direct message';
    }
    if (item.eventKind === 'gm') {
        return 'Group message';
    }
    return getActivityKindLabel(item.eventKind);
}

function isReminderLikeItem(item: ActivityPanelItem, actorName: string) {
    if (item.eventKind === 'reminder' || Boolean(item.reminderId) || Boolean(item.sourceRef?.reminderId)) {
        return true;
    }

    const actor = actorName.trim().toLowerCase();
    if (actor === 'remindbot') {
        return true;
    }

    const preview = (item.previewText || '').toLowerCase();
    return preview.includes('remind you about') || preview.includes('you asked me to remind you');
}

function getActivityKindMetaHtml(eventKind: string) {
    const iconClass = ACTIVITY_KIND_ICONS[eventKind];
    if (iconClass) {
        return `<span class="desktop-activity-kind" title="${escapeHtml(getActivityKindLabel(eventKind))}"><i class="icon ${iconClass}" aria-hidden="true"></i></span>`;
    }
    return `<span class="desktop-activity-kind">${escapeHtml(getActivityKindLabel(eventKind))}</span>`;
}

function getActivityDisplayKind(item: ActivityPanelItem) {
    const actorName = getActivityActorName(item);
    return isReminderLikeItem(item, actorName) ? 'reminder' : item.eventKind;
}

function isActivityKindEnabled(kind: string) {
    return activityKindFilters[kind] !== false;
}

function isActivityHighlightedItem(item: ActivityPanelItem) {
    const kindForDisplay = getActivityDisplayKind(item);
    if (kindForDisplay === 'dm' || kindForDisplay === 'gm' || kindForDisplay === 'reminder') {
        return true;
    }
    if (item.eventKind === 'reaction') {
        return true; // reactions = someone reacted to my post, always "highlighted"
    }
    if (item.eventKind === 'mention' || item.eventKind === 'thread_reply') {
        const hasPersonalMention = item.sourceRef?.personalMention === 'true';
        const hasBroadcastMention = item.sourceRef?.broadcastMention === 'true';
        return hasPersonalMention || hasBroadcastMention;
    }
    return false;
}

function renderFilterButtonsHtml() {
    const allEnabled = ACTIVITY_FILTER_KINDS.every((kind) => isActivityKindEnabled(kind));
    const allClass = allEnabled ? 'desktop-activity-filter-btn desktop-activity-filter-btn--all is-active' : 'desktop-activity-filter-btn desktop-activity-filter-btn--all';
    const allPressed = allEnabled ? 'true' : 'false';
    const allButton = `<button class="${allClass}" data-action="toggle-filter-all" aria-pressed="${allPressed}" type="button">All</button>`;
    const kindButtons = ACTIVITY_FILTER_KINDS.map((kind) => {
        const iconClass = ACTIVITY_KIND_ICONS[kind];
        const isActive = isActivityKindEnabled(kind);
        const className = isActive ? 'desktop-activity-filter-btn is-active' : 'desktop-activity-filter-btn';
        const pressed = isActive ? 'true' : 'false';
        const label = getActivityKindLabel(kind);
        const icon = iconClass ? `<i class="icon ${iconClass}" aria-hidden="true"></i>` : '';
        return `<button class="${className}" data-action="toggle-filter" data-kind="${kind}" aria-pressed="${pressed}" title="${escapeHtml(label)}" type="button">${icon}</button>`;
    }).join('');
    return `${allButton}${kindButtons}`;
}

function renderActivityPanel() {
    const panel = ensureActivityPanel();
    const feed = panel.querySelector<HTMLElement>('[data-role="feed"]');
    const filters = panel.querySelector<HTMLElement>('[data-role="filters"]');
    const highlightedOnlyInput = panel.querySelector<HTMLInputElement>('[data-role="highlighted-only"]');
    const hideThreadsInput = panel.querySelector<HTMLInputElement>('[data-role="hide-threads"]');
    const hideMentionsReactionsInput = panel.querySelector<HTMLInputElement>('[data-role="hide-mentions-reactions"]');

    if (filters) {
        filters.innerHTML = renderFilterButtonsHtml();
    }
    if (highlightedOnlyInput) {
        highlightedOnlyInput.checked = activityHighlightedOnlyFilter;
    }
    if (hideThreadsInput) {
        hideThreadsInput.checked = !activityHideThreadItems;
    }
    if (hideMentionsReactionsInput) {
        hideMentionsReactionsInput.checked = !activityHideMentionReactionItems;
    }

    if (!feed) {
        return;
    }

    const filteredItems = activityItems.filter((item) => {
        if (activityHiddenItemIds.has(getActivityPanelItemId(item))) {
            return false;
        }
        if (!isActivityKindEnabled(getActivityDisplayKind(item))) {
            return false;
        }
        if (activityHighlightedOnlyFilter && !isActivityHighlightedItem(item)) {
            return false;
        }
        return true;
    });
    const visibleItems = filteredItems.slice(0, activityVisibleCount);

    if (activityPanelLoading && !visibleItems.length) {
        feed.innerHTML = '<div class="desktop-activity-loading">Loading...</div>';
        return;
    }

    if (activityPanelError && !visibleItems.length) {
        feed.innerHTML = `<div class="desktop-activity-error">${activityPanelError}</div>`;
        return;
    }

    if (!visibleItems.length) {
        const loadMoreHtml = activityPanelHasMore ? `<div class="desktop-activity-loading desktop-activity-load-more-row"><button class="desktop-activity-load-more" data-action="load-older" type="button" ${activityPanelLoading ? 'disabled' : ''}>Load more</button></div>` : '';
        feed.innerHTML = `<div class="desktop-activity-empty">No activity yet</div>${loadMoreHtml}`;
        return;
    }

    let previousDayLabel = '';
    const itemsHtml = visibleItems.map((item) => {
        const actorName = getActivityActorName(item);
        const title = getActivityTitle(item, actorName);
        const message = getActivityMessage(item, actorName);
        const isReminderLike = isReminderLikeItem(item, actorName);
        const kindForDisplay = isReminderLike ? 'reminder' : item.eventKind;
        const avatarHtml = getActivityAvatarHtml({
            ...item,
            eventKind: kindForDisplay,
        });
        const groupMembers = item.sourceRef?.groupMembers || '';
        const renderedBody = item.eventKind === 'reaction' ?
            getReactionMessageHtml(item, message || item.previewText || '(no preview)') :
            renderActivityMarkdown(message || item.previewText || '(no preview)');
        const dayLabel = getActivityDayBadgeLabel(item.eventTs);
        const daySeparator = dayLabel && dayLabel !== previousDayLabel ?
            `<div class="desktop-activity-day-separator"><span class="desktop-activity-day-separator-badge">${escapeHtml(dayLabel)}</span></div>` :
            '';
        previousDayLabel = dayLabel || previousDayLabel;
        const safeTitle = escapeHtml(title);
        const kindMetaHtml = getActivityKindMetaHtml(kindForDisplay);
        const hasPersonalMention = item.sourceRef?.personalMention === 'true';
        const hasBroadcastMention = item.sourceRef?.broadcastMention === 'true';
        const unreadDotHtml = kindForDisplay === 'dm' ?
            '<span class="desktop-activity-unread-dot" title="Unread"></span>' :
            (hasPersonalMention && !hasBroadcastMention ? '<span class="desktop-activity-unread-dot" title="Unread"></span>' : '');
        const safeGmMeta = item.eventKind === 'gm' && groupMembers ? `<span class="desktop-activity-gm-meta">${escapeHtml(groupMembers)}</span>` : '';
        const channelName = (item.sourceRef?.channelName || '').trim();
        const shouldShowChannelMeta = (item.eventKind === 'mention' || item.eventKind === 'thread_reply') && channelName;
        const safeMentionChannelMeta = shouldShowChannelMeta ? `<span class="desktop-activity-channel-meta">${escapeHtml(channelName)}</span>` : '';
        const itemId = getActivityPanelItemId(item);
        const reminderClass = isReminderLike ? ' desktop-activity-item--reminder' : '';
        const isDM = kindForDisplay === 'dm';
        const personalMentionClass = !isDM && hasPersonalMention ? ' desktop-activity-item--mention-personal' : '';
        const broadcastMentionClass = !isDM && !hasPersonalMention && hasBroadcastMention ? ' desktop-activity-item--mention-broadcast' : '';
        return `${daySeparator}<div class="desktop-activity-item${reminderClass}${personalMentionClass}${broadcastMentionClass}" data-kind="${escapeHtml(kindForDisplay)}">
  <div
    class="desktop-activity-item-body desktop-activity-item-clickable"
    data-action="open-item"
    data-post-id="${item.postId || ''}"
    data-thread-id="${item.threadId || ''}"
    data-channel-id="${item.channelId || ''}"
  >
    ${avatarHtml}
    <div class="desktop-activity-item-content">
      <div class="desktop-activity-title-row">
        <div class="desktop-activity-actor"><strong>${safeTitle}</strong></div>
        <span class="desktop-activity-item-meta">${safeGmMeta}${safeMentionChannelMeta}${unreadDotHtml}${kindMetaHtml}<span class="desktop-activity-item-time">${formatActivityTime(item.eventTs)}</span><button class="desktop-activity-item-hide" type="button" data-action="hide-item" data-item-id="${escapeHtml(itemId)}" aria-label="Hide" title="Hide">×</button></span>
      </div>
      <div class="desktop-activity-message">${renderedBody}</div>
    </div>
  </div>
</div>`;
    }).join('');

    const loadMoreHtml = activityPanelHasMore ? `<div class="desktop-activity-loading desktop-activity-load-more-row"><button class="desktop-activity-load-more" data-action="load-older" type="button" ${activityPanelLoading ? 'disabled' : ''}>Load more</button></div>` : '';
    const progressiveMeta = activityVisibleCount < filteredItems.length ? `<div class="desktop-activity-loading">Loaded ${Math.min(activityVisibleCount, filteredItems.length)}/${filteredItems.length}</div>` : '';
    const loadingMeta = activityPanelLoading ? '<div class="desktop-activity-loading">Loading...</div>' : '';
    const errorMeta = activityPanelError ? `<div class="desktop-activity-error">${activityPanelError}</div>` : '';
    feed.innerHTML = `${errorMeta}${itemsHtml}${progressiveMeta}${loadMoreHtml}${loadingMeta}`;
    wireActivityAvatarImages(feed);

}

async function refreshActivityPanel(keepExisting = false) {
    if (activityRefreshInFlight) {
        logActivityPanel('refresh_skipped_inflight');
        return activityRefreshInFlight;
    }

    activityRefreshInFlight = (async () => {
        activityPanelLoading = true;
        if (!keepExisting) {
            activityPanelError = '';
        }
        logActivityPanel('refresh_start');
        renderActivityPanel();
        try {
            const page = await ipcRenderer.invoke(ACTIVITY_REFRESH, {pageSize: 50}) as ActivityPanelPage;
            setActivityItems(page.items || [], false);
            activityPanelHasMore = page.hasMore !== false;
            const pageErrors = page.errors || [];
            if (!activityItems.length && pageErrors.length) {
                activityPanelError = pageErrors.map((err) => `${err.source}: ${err.message}`).join(' | ');
            }
            logActivityPanel('refresh_done', {items: activityItems.length, errors: pageErrors.length});
            if (pageErrors.length) {
                logActivityPanel('refresh_errors', {
                    errors: pageErrors.map((err) => ({source: err.source, message: err.message})),
                });
            }
        } catch (error) {
            activityPanelError = String(error);
            logActivityPanel('refresh_failed', {error: String(error)});
        } finally {
            activityPanelLoading = false;
            renderActivityPanel();
        }
    })().finally(() => {
        activityRefreshInFlight = null;
    });

    return activityRefreshInFlight;
}

async function loadOlderActivityPanel() {
    if (activityLoadOlderInFlight) {
        logActivityPanel('load_older_skipped_inflight');
        return activityLoadOlderInFlight;
    }

    activityLoadOlderInFlight = (async () => {
        activityPanelLoading = true;
        activityPanelError = '';
        logActivityPanel('load_older_start');
        renderActivityPanel();
        try {
            const page = await ipcRenderer.invoke(ACTIVITY_LOAD_OLDER, {pageSize: 30}) as ActivityPanelPage;
            setActivityItems(page.items || [], false);
            activityPanelHasMore = page.hasMore !== false;
            const pageErrors = page.errors || [];
            if (!activityItems.length && pageErrors.length) {
                activityPanelError = pageErrors.map((err) => `${err.source}: ${err.message}`).join(' | ');
            }
            logActivityPanel('load_older_done', {items: activityItems.length, errors: pageErrors.length});
            if (pageErrors.length) {
                logActivityPanel('load_older_errors', {
                    errors: pageErrors.map((err) => ({source: err.source, message: err.message})),
                });
            }
        } catch (error) {
            activityPanelError = String(error);
            logActivityPanel('load_older_failed', {error: String(error)});
        } finally {
            activityPanelLoading = false;
            renderActivityPanel();
        }
    })().finally(() => {
        activityLoadOlderInFlight = null;
    });

    return activityLoadOlderInFlight;
}

async function searchActivityPanel() {
    if (activitySearchInFlight) {
        logActivityPanel('search_local_skipped_inflight');
        return activitySearchInFlight;
    }

    const panel = ensureActivityPanel();
    const input = panel.querySelector<HTMLInputElement>('[data-role="query"]');
    const query = input?.value || '';

    activitySearchInFlight = (async () => {
        logActivityPanel('search_local_start', {query});
        activityPanelLoading = true;
        activityPanelError = '';
        renderActivityPanel();
        try {
            const result = await ipcRenderer.invoke(ACTIVITY_SEARCH_LOCAL, {query});
            setActivityItems(Array.isArray(result) ? result as ActivityPanelItem[] : [], false);
            activityPanelHasMore = false;
            logActivityPanel('search_local_done', {items: activityItems.length});
        } catch (error) {
            activityPanelError = String(error);
            logActivityPanel('search_local_failed', {error: String(error)});
        } finally {
            activityPanelLoading = false;
            renderActivityPanel();
        }
    })().finally(() => {
        activitySearchInFlight = null;
    });

    return activitySearchInFlight;
}

async function bootstrapActivityPanel() {
    activityPanelLoading = true;
    activityPanelError = '';
    activityPanelHasMore = true;
    logActivityPanel('bootstrap_start');
    renderActivityPanel();

    let hadSnapshot = false;
    try {
        const snapshot = await ipcRenderer.invoke(ACTIVITY_GET_SNAPSHOT, {pageSize: 50}) as ActivityPanelPage;
        activityPanelHasMore = snapshot.hasMore !== false;
        if (snapshot.items?.length) {
            setActivityItems(snapshot.items, false);
            hadSnapshot = true;
            logActivityPanel('bootstrap_snapshot_loaded', {items: snapshot.items.length});
        } else {
            logActivityPanel('bootstrap_snapshot_empty');
        }
    } catch (error) {
        logActivityPanel('bootstrap_snapshot_failed', {error: String(error)});
    }

    await refreshActivityPanel(hadSnapshot);
}

function setActivityPanelVisible(isVisible: boolean) {
    const panel = ensureActivityPanel();
    updateActivityPanelPosition();
    panel.classList.toggle('visible', isVisible);
    logActivityPanel(isVisible ? 'panel_visible' : 'panel_hidden');
    if (isVisible) {
        const queryInput = panel.querySelector<HTMLInputElement>('[data-role="query"]');
        if (queryInput) {
            queryInput.value = '';
        }
        bootstrapActivityPanel().catch(() => {
            // ignore interaction errors
        });
    } else {
        clearActivityRenderTimer();
    }
}

function injectActivitySidebarItem() {
    if (document.getElementById(ACTIVITY_ITEM_ID)) {
        return;
    }

    // Strategy: find an existing sidebar nav item (Threads, Drafts, etc.) and insert Activity after it.
    // The Mattermost sidebar uses several possible structures depending on version.
    const sidebarSelectors = [

        // v9+ structure: look for the nav items container
        () => {
            const threadsLink = document.querySelector('a[href*="/threads"], a[href*="/activity"]');
            return threadsLink?.closest('li, div.SidebarNavItem, div[class*="sidebarItem"]')?.parentElement;
        },

        // Alternative: find by aria label or data-testid
        () => {
            const el = document.querySelector('[data-testid="threadsLink"], [data-testid="draftsLink"]');
            return el?.closest('ul, nav, div')?.parentElement || el?.parentElement;
        },

        // Fallback: look for the sidebar navigation container
        () => document.querySelector('#sidebar-left .SidebarNavContainer, #sidebar-left nav, .sidebar--left nav'),
    ];

    let container: Element | null | undefined = null;
    let referenceItem: Element | null = null;

    for (const selector of sidebarSelectors) {
        container = selector();
        if (container) {
            break;
        }
    }

    if (!container) {
        return;
    }

    // Find the first navigation item to insert Activity above all items
    const navItems = container.querySelectorAll(':scope > li, :scope > a, :scope > div, :scope > button');
    if (navItems.length > 0) {
        referenceItem = navItems[0];
    }

    // Clone the structure from an existing item for visual consistency
    const existingLink = container.querySelector('a[href*="/threads"], a[href*="/drafts"]');
    let activityItem: HTMLElement;

    if (existingLink && existingLink.parentElement && existingLink.parentElement !== container) {
        // Clone the wrapper element (li or div)
        const wrapper = existingLink.parentElement;
        activityItem = wrapper.cloneNode(true) as HTMLElement;
        activityItem.id = ACTIVITY_ITEM_ID;

        // Update the link inside
        const link = activityItem.querySelector('a');
        if (link) {
            link.removeAttribute('href');
            link.style.cursor = 'pointer';
            link.setAttribute('aria-label', 'Activity');

            // Remove active/current classes from clone
            link.classList.remove('active', 'current');
            activityItem.classList.remove('active', 'current');

            // Replace the SVG inside <span class="icon"> with an Activity SVG
            const iconWrapper = link.querySelector('span.icon');
            if (iconWrapper) {
                iconWrapper.innerHTML = ACTIVITY_SVG_ICON;
            } else {
                const svg = link.querySelector('svg');
                if (svg && svg.parentElement) {
                    svg.parentElement.innerHTML = ACTIVITY_SVG_ICON;
                } else {
                    const span = document.createElement('span');
                    span.className = 'icon';
                    span.innerHTML = ACTIVITY_SVG_ICON;
                    link.prepend(span);
                }
            }

            // Update text
            const textSpans = link.querySelectorAll('span');
            let textUpdated = false;
            textSpans.forEach((span) => {
                if (span.children.length === 0 && span.textContent?.trim()) {
                    span.textContent = 'Activity';
                    textUpdated = true;
                }
            });
            if (!textUpdated) {
                const directText = Array.from(link.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
                if (directText) {
                    directText.textContent = 'Activity';
                }
            }

            // Remove any badge/count from clone
            const badge = link.querySelector('.badge, [class*="badge"], [class*="Badge"]');
            if (badge) {
                badge.remove();
            }
        }
    } else if (existingLink) {
        // The link itself is the direct child
        activityItem = existingLink.cloneNode(true) as HTMLElement;
        activityItem.id = ACTIVITY_ITEM_ID;
        activityItem.removeAttribute('href');
        (activityItem as HTMLAnchorElement).style.cursor = 'pointer';
        activityItem.classList.remove('active', 'current');

        const iconWrapper = activityItem.querySelector('span.icon');
        if (iconWrapper) {
            iconWrapper.innerHTML = ACTIVITY_SVG_ICON;
        } else {
            const svg = activityItem.querySelector('svg');
            if (svg && svg.parentElement) {
                svg.parentElement.innerHTML = ACTIVITY_SVG_ICON;
            } else {
                const span = document.createElement('span');
                span.className = 'icon';
                span.innerHTML = ACTIVITY_SVG_ICON;
                activityItem.prepend(span);
            }
        }

        const textSpans = activityItem.querySelectorAll('span');
        textSpans.forEach((span) => {
            if (span.children.length === 0 && span.textContent?.trim()) {
                span.textContent = 'Activity';
            }
        });

        const badge = activityItem.querySelector('.badge, [class*="badge"], [class*="Badge"]');
        if (badge) {
            badge.remove();
        }
    } else {
        // Fully manual fallback: create a simple item
        activityItem = document.createElement('div');
        activityItem.id = ACTIVITY_ITEM_ID;
        activityItem.style.cssText = 'display:flex;align-items:center;padding:6px 16px;cursor:pointer;color:inherit;opacity:0.72;font-size:14px;';
        activityItem.innerHTML = `<span class="icon" style="margin-right:8px;display:flex;align-items:center;">${ACTIVITY_SVG_ICON}</span><span>Activity</span>`;

        activityItem.addEventListener('mouseenter', () => {
            activityItem.style.opacity = '1';
            activityItem.style.backgroundColor = 'rgba(255,255,255,0.08)';
        });
        activityItem.addEventListener('mouseleave', () => {
            if (!activityItem.classList.contains('active')) {
                activityItem.style.opacity = '0.72';
                activityItem.style.backgroundColor = '';
            }
        });
    }

    // Click handler: notify main process
    activityItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearNativeSidebarSelection();
        setActivityItemActive(true);
        ipcRenderer.send(ACTIVITY_OPEN_SIDEBAR);
    });

    // Insert into sidebar
    if (referenceItem && referenceItem.parentElement === container) {
        referenceItem.before(activityItem);
    } else {
        container.appendChild(activityItem);
    }
}

function setActivityItemActive(isActive: boolean) {
    const item = document.getElementById(ACTIVITY_ITEM_ID);
    if (!item) {
        return;
    }

    const link = item.querySelector('a') || item;
    if (isActive) {
        clearNativeSidebarSelection();
        link.classList.add('active');
        item.classList.add('active');
        item.style.opacity = '1';
    } else {
        link.classList.remove('active');
        item.classList.remove('active');
        item.style.opacity = '';
    }

    setActivityPanelVisible(isActive);
}

// Listen for active state changes from main process
ipcRenderer.on(ACTIVITY_SIDEBAR_ACTIVE, (_, isActive: boolean) => {
    setActivityItemActive(isActive);
});

// Observe sidebar for the right moment to inject and for deactivation detection
const startSidebarObserver = () => {
    let injected = false;

    ensureActivityPanelStyle();
    if (ACTIVITY_DEMO_BLUR) {
        document.body.classList.add('activity-demo-blur-sidebar');
        let overlay = document.getElementById('desktop-activity-demo-blur-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'desktop-activity-demo-blur-overlay';
            document.body.appendChild(overlay);
        }
    }

    const tryInject = () => {
        if (!injected && document.getElementById('sidebar-left')) {
            injectActivitySidebarItem();
            if (document.getElementById(ACTIVITY_ITEM_ID)) {
                injected = true;
            }
        }
        applyNativeSidebarSectionVisibility();
    };

    // Try immediately
    tryInject();

    // Observe DOM changes to handle SPA navigation and late sidebar rendering
    const observer = new MutationObserver((mutations) => {
        if (!injected) {
            tryInject();
        }

        // Re-inject if our element was removed (React reconciliation)
        if (injected && !document.getElementById(ACTIVITY_ITEM_ID)) {
            injected = false;
            tryInject();
        }

        applyNativeSidebarSectionVisibility();

        // Detect when user clicks another sidebar item (active class appears elsewhere)
        for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const target = mutation.target as HTMLElement;
                if (target.id !== ACTIVITY_ITEM_ID &&
                    target.closest('#sidebar-left') &&
                    !target.closest(`#${ACTIVITY_ITEM_ID}`) &&
                    (target.classList.contains('active') || target.classList.contains('selected'))) {
                    const activityItem = document.getElementById(ACTIVITY_ITEM_ID);
                    if (activityItem?.classList.contains('active')) {
                        setActivityItemActive(false);
                        ipcRenderer.send(ACTIVITY_SIDEBAR_DEACTIVATED);
                    }
                }
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });

    window.addEventListener('resize', updateActivityPanelPosition);
};

// Start observer when DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startSidebarObserver();
} else {
    document.addEventListener('DOMContentLoaded', startSidebarObserver);
}

ipcRenderer.invoke(GET_DEVELOPER_MODE_SETTING, 'forceNewAPI').then((force) => {
    if (force) {
        return;
    }

    /****************************************************************************
     * LEGACY CODE BELOW
     * All of this code is deprecated and should be removed eventually
     * Current it is there to support older versions of the web app
     ****************************************************************************
    */

    /**
     * Legacy helper functions
     */

    const onLoad = () => {
        if (document.getElementById('root') === null) {
            console.warn('The guest is not assumed as mattermost-webapp');
            return;
        }
        watchReactAppUntilInitialized(() => {
            console.warn('Legacy preload initialized');
            ipcRenderer.send(REACT_APP_INITIALIZED);
            ipcRenderer.invoke(REQUEST_BROWSER_HISTORY_STATUS).then(sendHistoryButtonReturn);
        });
    };

    const onStorageChanged = (e: StorageEvent) => {
        if (e.key === '__login__' && e.storageArea === localStorage && e.newValue) {
            ipcRenderer.send(APP_LOGGED_IN);
        }
        if (e.key === '__logout__' && e.storageArea === localStorage && e.newValue) {
            ipcRenderer.send(APP_LOGGED_OUT);
        }
    };

    const isReactAppInitialized = () => {
        const initializedRoot =
        document.querySelector('#root.channel-view') || // React 16 webapp
        document.querySelector('#root .signup-team__container') || // React 16 login
        document.querySelector('div[data-reactroot]'); // Older React apps
        if (initializedRoot === null) {
            return false;
        }
        return initializedRoot.children.length !== 0;
    };

    const watchReactAppUntilInitialized = (callback: () => void) => {
        let count = 0;
        const interval = 500;
        const timeout = 30000;
        const timer = setInterval(() => {
            count += interval;
            if (isReactAppInitialized() || count >= timeout) { // assumed as webapp has been initialized.
                clearTimeout(timer);
                callback();
            }
        }, interval);
    };

    const checkUnread = () => {
        if (isReactAppInitialized()) {
            findUnread();
        } else {
            watchReactAppUntilInitialized(() => {
                findUnread();
            });
        }
    };

    const findUnread = () => {
        const classes = ['team-container unread', 'SidebarChannel unread', 'sidebar-item unread-title'];
        const isUnread = classes.some((classPair) => {
            const result = document.getElementsByClassName(classPair);
            return result && result.length > 0;
        });
        ipcRenderer.send(UNREAD_RESULT, isUnread);
    };

    let sessionExpired: boolean;
    const getUnreadCount = () => {
        // LHS not found => Log out => Count should be 0, but session may be expired.
        let isExpired;
        if (document.getElementById('sidebar-left') === null) {
            const extraParam = (new URLSearchParams(window.location.search)).get('extra');
            isExpired = extraParam === 'expired';
        } else {
            isExpired = false;
        }
        if (isExpired !== sessionExpired) {
            sessionExpired = isExpired;
            ipcRenderer.send(SESSION_EXPIRED, sessionExpired);
        }
    };

    /**
     * Legacy message passing code - can be running alongside the new API stuff
     */

    // Disabling no-explicit-any for this legacy code
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener('message', ({origin, data = {}}: {origin?: string; data?: {type?: string; message?: any}} = {}) => {
        const {type, message = {}} = data;
        if (origin !== window.location.origin) {
            return;
        }
        switch (type) {
        case 'webapp-ready':
        case 'get-app-version': {
            // register with the webapp to enable custom integration functionality
            ipcRenderer.invoke(GET_APP_INFO).then((info) => {
                console.log(`registering ${info.name} v${info.version} with the server`);
                window.postMessage(
                    {
                        type: 'register-desktop',
                        message: info,
                    },
                    window.location.origin || '*',
                );
            });
            break;
        }
        case 'dispatch-notification': {
            const {title, body, channel, teamId, url, silent, data: messageData} = message;
            channels.set(channel.id, channel);
            ipcRenderer.invoke(NOTIFY_MENTION, title, body, channel.id, teamId, url, silent, messageData.soundName);
            break;
        }
        case BROWSER_HISTORY_PUSH: {
            const {path} = message as {path: string};
            ipcRenderer.send(BROWSER_HISTORY_PUSH, path);
            break;
        }
        case 'history-button': {
            ipcRenderer.invoke(REQUEST_BROWSER_HISTORY_STATUS).then(sendHistoryButtonReturn);
            break;
        }
        case CALLS_LINK_CLICK: {
            ipcRenderer.send(CALLS_LINK_CLICK, message.link);
            break;
        }
        case GET_DESKTOP_SOURCES: {
            ipcRenderer.invoke(GET_DESKTOP_SOURCES, message).then(sendDesktopSourcesResult);
            break;
        }
        case CALLS_WIDGET_SHARE_SCREEN: {
            ipcRenderer.send(CALLS_WIDGET_SHARE_SCREEN, message.sourceID, message.withAudio);
            break;
        }
        case CALLS_JOIN_CALL: {
            ipcRenderer.invoke(CALLS_JOIN_CALL, message).then(sendCallsJoinedCall);
            break;
        }
        case CALLS_JOINED_CALL: {
            ipcRenderer.send(CALLS_JOINED_CALL, message.callID, message.sessionID);
            break;
        }
        case CALLS_JOIN_REQUEST: {
            ipcRenderer.send(CALLS_JOIN_REQUEST, message.callID);
            break;
        }
        case CALLS_WIDGET_RESIZE: {
            ipcRenderer.send(CALLS_WIDGET_RESIZE, message.width, message.height);
            break;
        }
        case CALLS_ERROR: {
            ipcRenderer.send(CALLS_ERROR, message.err, message.callID, message.errMsg);
            break;
        }
        case CALLS_WIDGET_CHANNEL_LINK_CLICK:
        case CALLS_LEAVE_CALL:
        case DESKTOP_SOURCES_MODAL_REQUEST:
        case CALLS_POPOUT_FOCUS: {
            ipcRenderer.send(type);
        }
        }
    });

    // Legacy support to hold the full channel object so that it can be used for the click event
    const channels: Map<string, {id: string}> = new Map();
    ipcRenderer.on(NOTIFICATION_CLICKED, (event, channelId, teamId, url) => {
        const channel = channels.get(channelId) ?? {id: channelId};
        channels.delete(channelId);
        window.postMessage(
            {
                type: NOTIFICATION_CLICKED,
                message: {
                    channel,
                    teamId,
                    url,
                },
            },
            window.location.origin,
        );
    });

    ipcRenderer.on(BROWSER_HISTORY_PUSH, (event, pathName) => {
        window.postMessage(
            {
                type: 'browser-history-push-return',
                message: {
                    pathName,
                },
            },
            window.location.origin,
        );
    });

    const sendHistoryButtonReturn = (status: {canGoBack: boolean; canGoForward: boolean}) => {
        window.postMessage(
            {
                type: 'history-button-return',
                message: {
                    enableBack: status.canGoBack,
                    enableForward: status.canGoForward,
                },
            },
            window.location.origin,
        );
    };

    ipcRenderer.on(BROWSER_HISTORY_STATUS_UPDATED, (event, canGoBack, canGoForward) => sendHistoryButtonReturn({canGoBack, canGoForward}));

    const sendDesktopSourcesResult = (sources: Array<{
        id: string;
        name: string;
        thumbnailURL: string;
    }>) => {
        window.postMessage(
            {
                type: DESKTOP_SOURCES_RESULT,
                message: sources,
            },
            window.location.origin,
        );
    };

    const sendCallsJoinedCall = (message: {callID: string; sessionID: string}) => {
        window.postMessage(
            {
                type: CALLS_JOINED_CALL,
                message,
            },
            window.location.origin,
        );
    };

    ipcRenderer.on(CALLS_JOIN_REQUEST, (_, callID) => {
        window.postMessage(
            {
                type: CALLS_JOIN_REQUEST,
                message: {callID},
            },
            window.location.origin,
        );
    });

    ipcRenderer.on(DESKTOP_SOURCES_MODAL_REQUEST, () => {
        window.postMessage(
            {
                type: DESKTOP_SOURCES_MODAL_REQUEST,
            },
            window.location.origin,
        );
    });

    ipcRenderer.on(CALLS_WIDGET_SHARE_SCREEN, (_, sourceID, withAudio) => {
        window.postMessage(
            {
                type: CALLS_WIDGET_SHARE_SCREEN,
                message: {sourceID, withAudio},
            },
            window.location.origin,
        );
    });

    ipcRenderer.on(CALLS_ERROR, (_, err, callID, errMsg) => {
        window.postMessage(
            {
                type: CALLS_ERROR,
                message: {err, callID, errMsg},
            },
            window.location.origin,
        );
    });

    // push user activity updates to the webapp
    ipcRenderer.on(USER_ACTIVITY_UPDATE, (event, userIsActive, isSystemEvent) => {
        if (window.location.origin !== 'null') {
            window.postMessage({type: USER_ACTIVITY_UPDATE, message: {userIsActive, manual: isSystemEvent}}, window.location.origin);
        }
    });

    /**
     * Legacy functionality that needs to be disabled with the new API
     */

    legacyEnabled = true;
    ipcRenderer.on(IS_UNREAD, checkUnread);
    const unreadInterval = setInterval(getUnreadCount, 1000);
    window.addEventListener('storage', onStorageChanged);
    window.addEventListener('load', onLoad);

    legacyOff = () => {
        ipcRenderer.send(LEGACY_OFF);
        ipcRenderer.off(IS_UNREAD, checkUnread);
        clearInterval(unreadInterval);
        window.removeEventListener('storage', onStorageChanged);
        window.removeEventListener('load', onLoad);

        legacyEnabled = false;
        console.log('New API preload initialized');
    };
});
