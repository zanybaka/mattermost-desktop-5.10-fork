// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {net, session} from 'electron';

import {COOKIE_NAME_AUTH_TOKEN, COOKIE_NAME_CSRF, COOKIE_NAME_USER_ID} from 'common/constants';
import {Logger} from 'common/log';

const log = new Logger('serverAPI');

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

export async function getServerAPI(url: URL, isAuthenticated: boolean, onSuccess?: (raw: string) => void, onAbort?: () => void, onError?: (error: Error) => void) {
    if (isAuthenticated) {
        const cookies = await session.defaultSession.cookies.get({url: url.origin});
        if (!cookies) {
            const error = new Error('Cannot authenticate, no cookies present');
            log.error(error.message);
            onError?.(error);
            return;
        }

        // Filter out cookies that aren't part of our domain
        const filteredCookies = cookies.filter((cookie) => cookieMatchesHost(cookie.domain, url.hostname));

        const userId = filteredCookies.find((cookie) => cookie.name === COOKIE_NAME_USER_ID);
        const csrf = filteredCookies.find((cookie) => cookie.name === COOKIE_NAME_CSRF);
        const authToken = filteredCookies.find((cookie) => cookie.name === COOKIE_NAME_AUTH_TOKEN);

        // For API GET requests we only need authenticated session token.
        if (!authToken) {
            const error = new Error(`Cannot authenticate, auth cookie for ${url.origin} not found`);
            log.error(error.message);
            onError?.(error);
            return;
        }

        log.silly('Authenticated request cookies resolved', {
            host: url.hostname,
            hasUserId: Boolean(userId),
            hasCsrf: Boolean(csrf),
            hasAuthToken: Boolean(authToken),
        });
    }

    const req = net.request({
        url: url.toString(),
        session: session.defaultSession,
        useSessionCookies: true,
    });

    if (onSuccess) {
        req.on('response', (response: Electron.IncomingMessage) => {
            log.silly('response', response);
            if (response.statusCode === 200) {
                let raw = '';
                response.on('data', (chunk: Buffer) => {
                    log.silly('response.data', `${chunk}`);
                    raw += `${chunk}`;
                });
                response.on('end', () => {
                    try {
                        onSuccess(raw);
                    } catch (e) {
                        const error = `Error parsing server data from ${url.toString()}`;
                        log.error(error);
                        onError?.(new Error(error));
                    }
                });
            } else {
                onError?.(new Error(`Bad status code requesting from ${url.toString()}`));
            }
            response.on('error', onError || (() => {}));
        });
    }
    if (onAbort) {
        req.on('abort', onAbort);
    }
    if (onError) {
        req.on('error', onError);
    }
    req.end();
}
