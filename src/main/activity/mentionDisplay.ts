// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {fetchServerJSONCached} from './activityAPI';

type UserRecord = {
    username?: string;
    first_name?: string;
    last_name?: string;
};

const USERNAME_DISPLAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const usernameDisplayCache = new Map<string, {expiresAt: number; value: string | null}>();
const usernameDisplayInFlight = new Map<string, Promise<string | null>>();

function formatUserDisplayName(user?: UserRecord): string {
    if (!user) {
        return '';
    }
    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    return fullName || user.username || '';
}

function extractMentionUsernames(text: string): string[] {
    const regex = /(^|[\s(])@([a-z0-9._-]+)/gi;
    const usernames = new Set<string>();
    let match = regex.exec(text);
    while (match) {
        usernames.add((match[2] || '').toLowerCase());
        match = regex.exec(text);
    }
    return Array.from(usernames).filter(Boolean);
}

async function resolveDisplayNameByUsername(serverId: string, username: string): Promise<string | null> {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) {
        return null;
    }

    const key = `${serverId}:${normalizedUsername}`;
    const now = Date.now();
    const cached = usernameDisplayCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const inFlight = usernameDisplayInFlight.get(key);
    if (inFlight) {
        return inFlight;
    }

    const request = (async () => {
        const response = await fetchServerJSONCached(
            serverId,
            `/api/v4/users/username/${encodeURIComponent(normalizedUsername)}`,
            USERNAME_DISPLAY_CACHE_TTL_MS,
        );

        let value: string | null = null;
        if (response.ok && response.data && typeof response.data === 'object') {
            const displayName = formatUserDisplayName(response.data as UserRecord).trim();
            value = displayName || null;
        }

        usernameDisplayCache.set(key, {
            expiresAt: Date.now() + USERNAME_DISPLAY_CACHE_TTL_MS,
            value,
        });

        return value;
    })().finally(() => {
        usernameDisplayInFlight.delete(key);
    });

    usernameDisplayInFlight.set(key, request);
    return request;
}

export async function replaceMentionUsernamesWithDisplayNames(
    serverId: string,
    value: string,
    cache: Map<string, string | null>,
    selfUsername = '',
): Promise<{text: string; hasPersonalMention: boolean; hasBroadcastMention: boolean}> {
    const text = value || '';
    if (!text || text.startsWith('http://') || text.startsWith('https://') || !text.includes('@')) {
        return {text, hasPersonalMention: false, hasBroadcastMention: false};
    }

    const normalizedSelfUsername = selfUsername.trim().toLowerCase();
    const hasBroadcastMention = /(^|[\s(])@(here|all|channel)\b/i.test(text);
    const usernames = extractMentionUsernames(text);
    await Promise.all(usernames.map(async (username) => {
        if (cache.has(username)) {
            return;
        }
        const displayName = await resolveDisplayNameByUsername(serverId, username);
        cache.set(username, displayName);
    }));

    let hasPersonalMention = false;
    const renderedText = text.replace(/(^|[\s(])@([a-z0-9._-]+)/gi, (fullMatch, prefix: string, username: string) => {
        if (normalizedSelfUsername && String(username || '').toLowerCase() === normalizedSelfUsername) {
            hasPersonalMention = true;
        }
        const replacement = cache.get((username || '').toLowerCase());
        if (!replacement) {
            return fullMatch;
        }
        return `${prefix}@${replacement}`;
    });

    return {
        text: renderedText,
        hasPersonalMention,
        hasBroadcastMention,
    };
}

export async function getCurrentUserUsername(serverId: string, userId: string): Promise<string> {
    if (!userId) {
        return '';
    }
    const response = await fetchServerJSONCached(serverId, `/api/v4/users/${encodeURIComponent(userId)}`);
    if (!response.ok || !response.data || typeof response.data !== 'object') {
        return '';
    }
    return String((response.data as UserRecord).username || '').trim();
}
