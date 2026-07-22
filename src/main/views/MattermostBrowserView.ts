// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {BrowserView, app, ipcMain} from 'electron';
import type {BrowserViewConstructorOptions, Event, Input} from 'electron/main';
import {EventEmitter} from 'events';

import AppState from 'common/appState';
import {
    LOAD_RETRY,
    LOAD_SUCCESS,
    LOAD_FAILED,
    UPDATE_TARGET_URL,
    IS_UNREAD,
    TOGGLE_BACK_BUTTON,
    LOADSCREEN_END,
    SERVERS_URL_MODIFIED,
    BROWSER_HISTORY_STATUS_UPDATED,
    CLOSE_SERVERS_DROPDOWN,
    CLOSE_DOWNLOADS_DROPDOWN,
} from 'common/communication';
import type {Logger} from 'common/log';
import ServerManager from 'common/servers/serverManager';
import {RELOAD_INTERVAL, MAX_SERVER_RETRIES, SECOND, MAX_LOADING_SCREEN_SECONDS} from 'common/utils/constants';
import {isInternalURL, parseURL} from 'common/utils/url';
import {TAB_MESSAGING, type MattermostView} from 'common/views/View';
import DeveloperMode from 'main/developerMode';
import performanceMonitor from 'main/performanceMonitor';
import {getServerAPI} from 'main/server/serverAPI';
import MainWindow from 'main/windows/mainWindow';

import WebContentsEventManager from './webContentEvents';

import {getActivityViewBounds} from '../activitySidebarState';
import ContextMenu from '../contextMenu';
import {getLocalPreload, composeUserAgent, shouldHaveBackBar} from '../utils';

enum Status {
    LOADING,
    READY,
    WAITING_MM,
    ERROR = -1,
}

const MENTIONS_GROUP = 2;
const titleParser = /(\((\d+)\) )?(\* )?/g;

export class MattermostBrowserView extends EventEmitter {
    view: MattermostView;
    isVisible: boolean;

    private log: Logger;
    private browserView: BrowserView;
    private loggedIn: boolean;
    private atRoot: boolean;
    private options: BrowserViewConstructorOptions;
    private removeLoading?: NodeJS.Timeout;
    private contextMenu?: ContextMenu;
    private status?: Status;
    private retryLoad?: NodeJS.Timeout;
    private maxRetries: number;
    private altPressStatus: boolean;

    constructor(view: MattermostView, options: BrowserViewConstructorOptions) {
        super();
        this.view = view;

        const preload = getLocalPreload('externalAPI.js');
        this.options = Object.assign({}, options);
        this.options.webPreferences = {
            preload: DeveloperMode.get('browserOnly') ? undefined : preload,
            additionalArguments: [
                `version=${app.getVersion()}`,
                `appName=${app.name}`,
            ],
            ...options.webPreferences,
        };
        this.isVisible = false;
        this.loggedIn = false;
        this.atRoot = true;
        this.browserView = new BrowserView(this.options);
        this.resetLoadingStatus();

        this.log = ServerManager.getViewLog(this.id, 'MattermostBrowserView');
        this.log.verbose('View created');

        this.browserView.webContents.on('update-target-url', this.handleUpdateTarget);
        this.browserView.webContents.on('did-navigate', this.handleDidNavigate);
        if (process.platform !== 'darwin') {
            this.browserView.webContents.on('before-input-event', this.handleInputEvents);
        }
        this.browserView.webContents.on('input-event', (_, inputEvent) => {
            if (inputEvent.type === 'mouseDown') {
                ipcMain.emit(CLOSE_SERVERS_DROPDOWN);
                ipcMain.emit(CLOSE_DOWNLOADS_DROPDOWN);
            }
        });

        // Legacy handlers using the title/favicon
        this.browserView.webContents.on('page-title-updated', this.handleTitleUpdate);
        this.browserView.webContents.on('page-favicon-updated', this.handleFaviconUpdate);

        WebContentsEventManager.addWebContentsEventListeners(this.browserView.webContents);

        if (!DeveloperMode.get('disableContextMenu')) {
            this.contextMenu = new ContextMenu({}, this.browserView);
        }

        this.maxRetries = MAX_SERVER_RETRIES;

        this.altPressStatus = false;

        MainWindow.get()?.on('blur', () => {
            this.altPressStatus = false;
        });

        ServerManager.on(SERVERS_URL_MODIFIED, this.handleServerWasModified);
    }

    get id() {
        return this.view.id;
    }
    get isAtRoot() {
        return this.atRoot;
    }
    get isLoggedIn() {
        return this.loggedIn;
    }
    get currentURL() {
        return parseURL(this.browserView.webContents.getURL());
    }
    get webContentsId() {
        return this.browserView.webContents.id;
    }

    requestJSON = async (url: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
        const options = {
            method,
            credentials: 'include',
            cache: 'no-store',
            headers: method === 'POST' ? {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            } : undefined,
            body: method === 'POST' ? JSON.stringify(body) : undefined,
        };
        const result = await this.browserView.webContents.executeJavaScript(
            `fetch(${JSON.stringify(url)}, ${JSON.stringify(options)})
                .then(async (response) => ({
                    ok: response.ok,
                    status: response.status,
                    text: await response.text(),
                }))
                .catch((error) => ({
                    ok: false,
                    status: 0,
                    text: '',
                    error: error instanceof Error ? error.message : String(error),
                }))`,
            true,
        ) as {ok: boolean; status: number; text: string; error?: string};

        if (!result.ok) {
            return {
                ok: false,
                error: result.error || `request failed with status ${result.status}`,
            };
        }

        try {
            return {
                ok: true,
                data: JSON.parse(result.text),
            };
        } catch {
            return {
                ok: false,
                error: 'failed to parse response',
            };
        }
    };

    onLogin = (loggedIn: boolean) => {
        if (this.isLoggedIn === loggedIn) {
            return;
        }

        this.loggedIn = loggedIn;

        // If we're logging in from a different view, force a reload
        if (loggedIn &&
            this.currentURL?.toString() !== this.view.url.toString() &&
            !this.currentURL?.toString().startsWith(this.view.url.toString())
        ) {
            this.reload();
        }
    };

    goToOffset = (offset: number) => {
        if (this.browserView.webContents.navigationHistory.canGoToOffset(offset)) {
            try {
                this.browserView.webContents.navigationHistory.goToOffset(offset);
                this.updateHistoryButton();
            } catch (error) {
                this.log.error(error);
                this.reload();
            }
        }
    };

    getBrowserHistoryStatus = () => {
        if (this.currentURL?.toString() === this.view.url.toString()) {
            this.browserView.webContents.navigationHistory.clear();
            this.atRoot = true;
        } else {
            this.atRoot = false;
        }

        return {
            canGoBack: this.browserView.webContents.navigationHistory.canGoBack(),
            canGoForward: this.browserView.webContents.navigationHistory.canGoForward(),
        };
    };

    updateHistoryButton = () => {
        const {canGoBack, canGoForward} = this.getBrowserHistoryStatus();
        this.browserView.webContents.send(BROWSER_HISTORY_STATUS_UPDATED, canGoBack, canGoForward);
    };

    load = (someURL?: URL | string) => {
        if (!this.browserView) {
            return;
        }

        let loadURL: string;
        if (someURL) {
            const parsedURL = parseURL(someURL);
            if (parsedURL) {
                loadURL = parsedURL.toString();
            } else {
                this.log.error('Cannot parse provided url, using current server url', someURL);
                loadURL = this.view.url.toString();
            }
        } else {
            loadURL = this.view.url.toString();
        }
        this.log.verbose(`Loading ${loadURL}`);
        if (this.view.type === TAB_MESSAGING) {
            performanceMonitor.registerServerView(`Server ${this.browserView.webContents.id}`, this.browserView.webContents, this.view.server.id);
        } else {
            performanceMonitor.registerView(`Server ${this.browserView.webContents.id}`, this.browserView.webContents, this.view.server.id);
        }
        const loading = this.browserView.webContents.loadURL(loadURL, {userAgent: composeUserAgent(DeveloperMode.get('browserOnly'))});
        loading.then(this.loadSuccess(loadURL)).catch((err) => {
            if (err.code && err.code.startsWith('ERR_CERT')) {
                MainWindow.sendToRenderer(LOAD_FAILED, this.id, err.toString(), loadURL.toString());
                this.emit(LOAD_FAILED, this.id, err.toString(), loadURL.toString());
                this.log.info(`Invalid certificate, stop retrying until the user decides what to do: ${err}.`);
                this.status = Status.ERROR;
                return;
            }
            if (err.code && err.code.startsWith('ERR_ABORTED')) {
                // If the loading was aborted, we shouldn't be retrying
                return;
            }
            this.loadRetry(loadURL, err);
        });
    };

    show = () => {
        const mainWindow = MainWindow.get();
        if (!mainWindow) {
            return;
        }
        if (!this.currentURL) {
            return;
        }
        if (this.isVisible) {
            return;
        }
        this.isVisible = true;
        mainWindow.addBrowserView(this.browserView);
        mainWindow.setTopBrowserView(this.browserView);
        this.setBounds(getActivityViewBounds(mainWindow, shouldHaveBackBar(this.view.url || '', this.currentURL)));
        if (this.status === Status.READY) {
            this.focus();
        }
    };

    hide = () => {
        if (this.isVisible) {
            this.isVisible = false;
            MainWindow.get()?.removeBrowserView(this.browserView);
        }
    };

    reload = (loadURL?: URL | string) => {
        this.resetLoadingStatus();
        AppState.updateExpired(this.id, false);
        this.load(loadURL);
    };

    getBounds = () => {
        return this.browserView.getBounds();
    };

    openFind = () => {
        this.browserView.webContents.sendInputEvent({type: 'keyDown', keyCode: 'F', modifiers: [process.platform === 'darwin' ? 'cmd' : 'ctrl', 'shift']});
    };

    setBounds = (boundaries: Electron.Rectangle) => {
        this.browserView.setBounds(boundaries);
    };

    destroy = () => {
        WebContentsEventManager.removeWebContentsListeners(this.webContentsId);
        AppState.clear(this.id);
        MainWindow.get()?.removeBrowserView(this.browserView);
        performanceMonitor.unregisterView(this.browserView.webContents.id);
        this.browserView.webContents.close();

        this.isVisible = false;
        if (this.retryLoad) {
            clearTimeout(this.retryLoad);
        }
        if (this.removeLoading) {
            clearTimeout(this.removeLoading);
        }
    };

    /**
     * Code to turn off the old method of getting unreads
     * Newer web apps will send the mentions/unreads directly
     */
    offLegacyUnreads = () => {
        this.browserView.webContents.off('page-title-updated', this.handleTitleUpdate);
        this.browserView.webContents.off('page-favicon-updated', this.handleFaviconUpdate);
    };

    /**
     * Status hooks
     */

    resetLoadingStatus = () => {
        if (this.status !== Status.LOADING) { // if it's already loading, don't touch anything
            delete this.retryLoad;
            this.status = Status.LOADING;
            this.maxRetries = MAX_SERVER_RETRIES;
        }
    };

    isReady = () => {
        return this.status === Status.READY;
    };

    isErrored = () => {
        return this.status === Status.ERROR;
    };

    needsLoadingScreen = () => {
        return !(this.status === Status.READY || this.status === Status.ERROR);
    };

    setInitialized = (timedout?: boolean) => {
        this.status = Status.READY;

        if (timedout) {
            this.log.verbose('timeout expired will show the browserview');
            this.emit(LOADSCREEN_END, this.id);
        }
        clearTimeout(this.removeLoading);
        delete this.removeLoading;
    };

    openDevTools = () => {
        // Workaround for a bug with our Dev Tools on Mac
        // For some reason if you open two Dev Tools windows and close the first one, it won't register the closing
        // So what we do here is check to see if it's opened correctly and if not we reset it
        if (process.platform === 'darwin') {
            const timeout = setTimeout(() => {
                if (this.browserView.webContents.isDevToolsOpened()) {
                    this.browserView.webContents.closeDevTools();
                    this.browserView.webContents.openDevTools({mode: 'detach'});
                }
            }, 500);
            this.browserView.webContents.on('devtools-opened', () => {
                clearTimeout(timeout);
            });
        }

        this.browserView.webContents.openDevTools({mode: 'detach'});
    };

    /**
     * WebContents hooks
     */

    sendToRenderer = (channel: string, ...args: any[]) => {
        this.browserView.webContents.send(channel, ...args);
    };

    isDestroyed = () => {
        return this.browserView.webContents.isDestroyed();
    };

    focus = () => {
        if (this.browserView.webContents) {
            this.browserView.webContents.focus();
        } else {
            this.log.warn('trying to focus the browserview, but it doesn\'t yet have webcontents.');
        }
    };

    getWebAppSidebarWidth = async () => {
        try {
            const width = await this.browserView.webContents.executeJavaScript(
                '(() => { const sidebar = document.getElementById("sidebar-left"); if (!sidebar) { return 0; } const rect = sidebar.getBoundingClientRect(); return Math.round(rect.width || 0); })()',
                true,
            );

            const numericWidth = Number(width);
            if (!Number.isFinite(numericWidth) || numericWidth <= 0) {
                return 0;
            }

            return numericWidth;
        } catch (error) {
            this.log.debug('unable to read webapp sidebar width', error);
            return 0;
        }
    };

    /**
     * ALT key handling for the 3-dot menu (Windows/Linux)
     */

    private registerAltKeyPressed = (input: Input) => {
        const isAltPressed = input.key === 'Alt' && input.alt === true && input.control === false && input.shift === false && input.meta === false;

        if (input.type === 'keyDown') {
            this.altPressStatus = isAltPressed;
        }

        if (input.key !== 'Alt') {
            this.altPressStatus = false;
        }
    };

    private isAltKeyReleased = (input: Input) => {
        return input.type === 'keyUp' && this.altPressStatus === true;
    };

    private handleInputEvents = (_: Event, input: Input) => {
        this.log.silly('handleInputEvents', input);

        this.registerAltKeyPressed(input);

        if (this.isAltKeyReleased(input)) {
            MainWindow.focusThreeDotMenu();
        }
    };

    /**
     * Unreads/mentions handlers
     */

    private updateMentionsFromTitle = (title: string) => {
        const resultsIterator = title.matchAll(titleParser);
        const results = resultsIterator.next(); // we are only interested in the first set
        const mentions = (results && results.value && parseInt(results.value[MENTIONS_GROUP], 10)) || 0;

        AppState.updateMentions(this.id, mentions);
    };

    // if favicon is null, it will affect appState, but won't be memoized
    private findUnreadState = (favicon: string | null) => {
        try {
            this.browserView.webContents.send(IS_UNREAD, favicon, this.id);
        } catch (err: any) {
            this.log.error('There was an error trying to request the unread state', err);
        }
    };

    private handleTitleUpdate = (e: Event, title: string) => {
        this.log.debug('handleTitleUpdate', title);

        this.updateMentionsFromTitle(title);
    };

    private handleFaviconUpdate = (e: Event, favicons: string[]) => {
        this.log.silly('handleFaviconUpdate', favicons);

        // if unread state is stored for that favicon, retrieve value.
        // if not, get related info from preload and store it for future changes
        this.findUnreadState(favicons[0]);
    };

    /**
     * Loading/retry logic
     */

    private retry = (loadURL: string) => {
        return () => {
            // window was closed while retrying
            if (!this.browserView || !this.browserView.webContents) {
                return;
            }
            const loading = this.browserView.webContents.loadURL(loadURL, {userAgent: composeUserAgent(DeveloperMode.get('browserOnly'))});
            loading.then(this.loadSuccess(loadURL)).catch((err) => {
                if (this.maxRetries-- > 0) {
                    this.loadRetry(loadURL, err);
                } else {
                    MainWindow.sendToRenderer(LOAD_FAILED, this.id, err.toString(), loadURL.toString());
                    this.emit(LOAD_FAILED, this.id, err.toString(), loadURL.toString());
                    this.log.info(`Couldn't esviewlish a connection with ${loadURL}, will continue to retry in the background`, err);
                    this.status = Status.ERROR;
                    this.retryLoad = setTimeout(this.retryInBackground(loadURL), RELOAD_INTERVAL);
                }
            });
        };
    };

    private retryInBackground = (loadURL: string) => {
        return () => {
            // window was closed while retrying
            if (!this.browserView || !this.browserView.webContents) {
                return;
            }
            const parsedURL = parseURL(loadURL);
            if (!parsedURL) {
                return;
            }
            getServerAPI(
                parsedURL,
                false,
                () => this.reload(loadURL),
                () => {},
                (error: Error) => {
                    this.log.debug(`Cannot reach server: ${error}`);
                    this.retryLoad = setTimeout(this.retryInBackground(loadURL), RELOAD_INTERVAL);
                });
        };
    };

    private loadRetry = (loadURL: string, err: Error) => {
        this.retryLoad = setTimeout(this.retry(loadURL), RELOAD_INTERVAL);
        MainWindow.sendToRenderer(LOAD_RETRY, this.id, Date.now() + RELOAD_INTERVAL, err.toString(), loadURL.toString());
        this.log.info(`failed loading ${loadURL}: ${err}, retrying in ${RELOAD_INTERVAL / SECOND} seconds`);
    };

    private loadSuccess = (loadURL: string) => {
        return () => {
            this.log.verbose(`finished loading ${loadURL}`);
            MainWindow.sendToRenderer(LOAD_SUCCESS, this.id);
            this.maxRetries = MAX_SERVER_RETRIES;
            if (this.status === Status.LOADING) {
                this.updateMentionsFromTitle(this.browserView.webContents.getTitle());
                this.findUnreadState(null);
            }
            this.status = Status.WAITING_MM;
            this.removeLoading = setTimeout(this.setInitialized, MAX_LOADING_SCREEN_SECONDS, true);
            this.emit(LOAD_SUCCESS, this.id, loadURL);
            const mainWindow = MainWindow.get();
            if (mainWindow && this.currentURL) {
                this.setBounds(getActivityViewBounds(mainWindow, shouldHaveBackBar(this.view.url || '', this.currentURL)));
            }
        };
    };

    /**
     * WebContents event handlers
     */

    private handleDidNavigate = (event: Event, url: string) => {
        this.log.debug('handleDidNavigate', url);

        const mainWindow = MainWindow.get();
        if (!mainWindow) {
            return;
        }
        const parsedURL = parseURL(url);
        if (!parsedURL) {
            return;
        }

        if (shouldHaveBackBar(this.view.url || '', parsedURL)) {
            this.setBounds(getActivityViewBounds(mainWindow, true));
            MainWindow.sendToRenderer(TOGGLE_BACK_BUTTON, true);
            this.log.debug('show back button');
        } else {
            this.setBounds(getActivityViewBounds(mainWindow, false));
            MainWindow.sendToRenderer(TOGGLE_BACK_BUTTON, false);
            this.log.debug('hide back button');
        }
    };

    private handleUpdateTarget = (e: Event, url: string) => {
        this.log.silly('handleUpdateTarget', e, url);
        const parsedURL = parseURL(url);
        if (parsedURL && isInternalURL(parsedURL, this.view.server.url)) {
            this.emit(UPDATE_TARGET_URL);
        } else {
            this.emit(UPDATE_TARGET_URL, url);
        }
    };

    private handleServerWasModified = (serverIds: string) => {
        if (serverIds.includes(this.view.server.id)) {
            this.reload();
        }
    };
}
