// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {net, session} from 'electron';

import {Logger} from 'common/log';
import ServerManager from 'common/servers/serverManager';
import {getServerAPI} from 'main/server/serverAPI';
import ViewManager from 'main/views/viewManager';

const log = new Logger('ActivityAPI');
const RESPONSE_CACHE_TTL_MS = 1000 * 60 * 10;
const responseCache = new Map<string, {expiresAt: number; value: ActivityFetchResult}>();
const inFlightRequests = new Map<string, Promise<ActivityFetchResult>>();

function normalizeDomain(domain?: string) {
    return (domain || '').trim().replace(/^\./, '').toLowerCase();
}

function cookieMatchesHost(cookieDomain: string | undefined, host: string) {
    const normalizedCookieDomain = normalizeDomain(cookieDomain);
    const normalizedHost = host.toLowerCase();
    if (!normalizedCookieDomain) {
        return false;
    }
    return normalizedHost === normalizedCookieDomain || normalizedHost.endsWith(`.${normalizedCookieDomain}`);
}

export type ActivityFetchResult = {
    ok: boolean;
    data?: unknown;
    error?: string;
};

function resolveURL(serverId: string, endpoint: string): URL | null {
    const server = ServerManager.getServer(serverId);
    if (!server) {
        return null;
    }
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return new URL(normalizedEndpoint, server.url.toString());
}

async function fetchThroughServerView(
    serverId: string,
    url: URL,
    method: 'GET' | 'POST',
    body?: unknown,
): Promise<ActivityFetchResult | null> {
    const view = ViewManager.getMessagingViewForServer(serverId);
    if (!view?.isReady()) {
        return null;
    }

    try {
        return await view.requestJSON(url.toString(), method, body);
    } catch (error) {
        log.debug('server view request failed', url.toString(), error);
        return null;
    }
}

export async function getUserIdForServer(serverId: string): Promise<string | undefined> {
    const server = ServerManager.getServer(serverId);
    if (!server) {
        return undefined;
    }

    const cookies = await session.defaultSession.cookies.get({url: server.url.origin});
    const matched = cookies.find((cookie) => {
        return cookie.name === 'MMUSERID' && cookieMatchesHost(cookie.domain, server.url.hostname);
    });
    return matched?.value;
}

export async function fetchServerJSON(serverId: string, endpoint: string): Promise<ActivityFetchResult> {
    const url = resolveURL(serverId, endpoint);
    if (!url) {
        return {
            ok: false,
            error: `unknown server id: ${serverId}`,
        };
    }

    const viewResult = await fetchThroughServerView(serverId, url, 'GET');
    if (viewResult) {
        return viewResult;
    }

    return new Promise<ActivityFetchResult>((resolve) => {
        let settled = false;
        const settle = (result: ActivityFetchResult) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        const timeout = setTimeout(() => {
            settle({
                ok: false,
                error: `request timeout for ${endpoint}`,
            });
        }, 10000);

        getServerAPI(
            url,
            true,
            (raw) => {
                clearTimeout(timeout);
                try {
                    settle({
                        ok: true,
                        data: JSON.parse(raw),
                    });
                } catch {
                    settle({
                        ok: false,
                        error: `failed to parse response for ${endpoint}`,
                    });
                }
            },
            undefined,
            (error) => {
                clearTimeout(timeout);
                log.debug('fetchServerJSON failed', endpoint, error?.message);
                settle({
                    ok: false,
                    error: error?.message || `request failed for ${endpoint}`,
                });
            },
        );
    });
}

function readResponseBody(response: Electron.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let raw = '';
        response.on('data', (chunk: Buffer) => {
            raw += `${chunk}`;
        });
        response.on('end', () => resolve(raw));
        response.on('error', reject);
    });
}

export async function postServerJSON(serverId: string, endpoint: string, body: unknown): Promise<ActivityFetchResult> {
    const url = resolveURL(serverId, endpoint);
    if (!url) {
        return {
            ok: false,
            error: `unknown server id: ${serverId}`,
        };
    }

    const viewResult = await fetchThroughServerView(serverId, url, 'POST', body);
    if (viewResult) {
        return viewResult;
    }

    return new Promise<ActivityFetchResult>((resolve) => {
        let settled = false;
        const settle = (result: ActivityFetchResult) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        const timeout = setTimeout(() => {
            settle({
                ok: false,
                error: `request timeout for ${endpoint}`,
            });
        }, 15000);

        const req = net.request({
            method: 'POST',
            url: url.toString(),
            session: session.defaultSession,
            useSessionCookies: true,
        });
        req.setHeader('Content-Type', 'application/json');
        req.on('response', async (response: Electron.IncomingMessage) => {
            clearTimeout(timeout);
            try {
                const raw = await readResponseBody(response);
                if (response.statusCode === 200) {
                    settle({
                        ok: true,
                        data: JSON.parse(raw),
                    });
                    return;
                }
                settle({
                    ok: false,
                    error: `request failed for ${endpoint} with status ${response.statusCode}`,
                });
            } catch (error) {
                settle({
                    ok: false,
                    error: error instanceof Error ? error.message : `failed to parse response for ${endpoint}`,
                });
            }
        });
        req.on('error', (error) => {
            clearTimeout(timeout);
            log.debug('postServerJSON failed', endpoint, error?.message);
            settle({
                ok: false,
                error: error?.message || `request failed for ${endpoint}`,
            });
        });
        req.write(JSON.stringify(body));
        req.end();
    });
}

export async function fetchServerJSONCached(serverId: string, endpoint: string, ttlMs = RESPONSE_CACHE_TTL_MS): Promise<ActivityFetchResult> {
    const key = `${serverId}::${endpoint}`;
    const now = Date.now();
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const inFlight = inFlightRequests.get(key);
    if (inFlight) {
        return inFlight;
    }

    const request = fetchServerJSON(serverId, endpoint).then((result) => {
        if (result.ok) {
            responseCache.set(key, {
                expiresAt: Date.now() + ttlMs,
                value: result,
            });
        }
        return result;
    }).finally(() => {
        inFlightRequests.delete(key);
    });
    inFlightRequests.set(key, request);
    return request;
}

export function getUserAvatarURL(serverId: string, userId?: string): string | undefined {
    if (!userId) {
        return undefined;
    }

    const url = resolveURL(serverId, `/api/v4/users/${encodeURIComponent(userId)}/image`);
    return url?.toString();
}

export function getEmojiImageURL(serverId: string, emojiId?: string): string | undefined {
    if (!emojiId) {
        return undefined;
    }

    const normalizedId = emojiId.trim();
    if (!normalizedId) {
        return undefined;
    }

    const url = resolveURL(serverId, `/api/v4/emoji/${encodeURIComponent(normalizedId)}/image`);
    return url?.toString();
}
