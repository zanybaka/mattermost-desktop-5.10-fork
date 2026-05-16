// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';

import {getCurrentUserUsername, replaceMentionUsernamesWithDisplayNames} from '../mentionDisplay';
import {fetchServerJSON, fetchServerJSONCached, getUserAvatarURL} from '../activityAPI';

type UserRecord = {
    id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
};

type ChannelRecord = {
    id: string;
    display_name?: string;
    name?: string;
};

function formatUserDisplayName(user?: UserRecord): string {
    if (!user) {
        return '';
    }
    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    return fullName || user.username || '';
}

function formatChannelDisplayName(channel?: ChannelRecord): string {
    if (!channel) {
        return '';
    }
    return (channel.display_name || channel.name || '').trim();
}

async function getTeamIds(serverId: string): Promise<string[]> {
    const response = await fetchServerJSON(serverId, '/api/v4/users/me/teams');
    if (!response.ok || !Array.isArray(response.data)) {
        return [];
    }

    return response.data.
        filter((team): team is Record<string, unknown> => Boolean(team && typeof team === 'object')).
        map((team) => String(team.id || '')).
        filter(Boolean);
}

function extractThreads(payload: unknown): Array<Record<string, unknown>> {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    const typed = payload as Record<string, unknown>;
    const threads = typed.threads;
    if (!Array.isArray(threads)) {
        return [];
    }

    return threads.filter((thread): thread is Record<string, unknown> => Boolean(thread && typeof thread === 'object'));
}

function getString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function getObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractThreadSnippet(thread: Record<string, unknown>): string {
    const lastReplyText = getString(thread.last_reply_text).trim();
    if (lastReplyText) {
        return lastReplyText;
    }

    const postObject = getObject(thread.post);
    if (postObject) {
        const postMessage = getString(postObject.message).trim();
        if (postMessage) {
            return postMessage;
        }
    }

    const message = getString(thread.message).trim();
    if (message) {
        return message;
    }

    const postAsString = getString(thread.post).trim();
    if (postAsString) {
        return postAsString;
    }

    return '';
}

function extractThreadActorUserId(thread: Record<string, unknown>): string | undefined {
    const candidates = [
        getString(thread.last_reply_user_id),
        getString(thread.last_reply_by),
    ];

    const postObject = getObject(thread.post);
    if (postObject) {
        candidates.push(getString(postObject.user_id));
    }

    const resolved = candidates.map((value) => value.trim()).find(Boolean);
    return resolved || undefined;
}

function extractThreadChannelId(thread: Record<string, unknown>): string {
    const directChannelId = getString(thread.channel_id).trim();
    if (directChannelId) {
        return directChannelId;
    }

    const postObject = getObject(thread.post);
    if (postObject) {
        const postChannelId = getString(postObject.channel_id).trim();
        if (postChannelId) {
            return postChannelId;
        }
    }

    return '';
}

function extractThreadEventTs(thread: Record<string, unknown>): number {
    const postObject = getObject(thread.post);
    const candidates = [
        Number(thread.last_reply_at || 0),
        Number(postObject?.update_at || 0),
        Number(postObject?.create_at || 0),
        Number(thread.update_at || 0),
        Number(thread.create_at || 0),
    ];

    const resolved = candidates.find((value) => Number.isFinite(value) && value > 0);
    return resolved || Date.now();
}

function normalizeThreadReply(
    serverId: string,
    userId: string,
    thread: Record<string, unknown>,
    actorName = '',
    channelName = '',
): ActivityItem {
    const postId = String(thread.post_id || thread.id || '');
    const channelId = extractThreadChannelId(thread);
    const rootId = String(thread.id || thread.post_id || '');
    const eventTs = extractThreadEventTs(thread);
    const snippet = extractThreadSnippet(thread);
    const actorUserId = extractThreadActorUserId(thread);

    return {
        canonicalId: '',
        eventKind: 'thread_reply',
        serverId,
        targetUserId: userId,
        eventTs,
        previewText: snippet,
        postId: postId || undefined,
        channelId: channelId || undefined,
        threadId: rootId || undefined,
        actorUserId,
        actorAvatarUrl: getUserAvatarURL(serverId, actorUserId),
        sourceRef: {
            threadId: rootId,
            postId,
            channelId,
            actorName: actorName || '',
            channelName: channelName || '',
        },
    };
}

export class ThreadsAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'thread_reply';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        const teamIds = await getTeamIds(params.serverId);
        const query = `deleted=false&page=${params.page}&per_page=${params.pageSize}&totalsOnly=false&extended=true&skipTotal=true&disable_channel_type_group=true`;
        const baseEndpoints = [
            `/api/v4/users/me/teams/threads?page=${params.page}&per_page=${params.pageSize}&extended=true`,
        ];
        const teamScopedEndpoints = teamIds.flatMap((teamId) => {
            const encodedTeamId = encodeURIComponent(teamId);
            const meEndpoint = `/api/v4/users/me/teams/${encodedTeamId}/threads?${query}`;
            const userEndpoint = params.userId ? `/api/v4/users/${encodeURIComponent(params.userId)}/teams/${encodedTeamId}/threads?${query}` : '';
            return [userEndpoint, meEndpoint].filter(Boolean);
        });
        const endpoints = [...baseEndpoints, ...teamScopedEndpoints];

        let collected: Array<Record<string, unknown>> = [];
        let lastError = '';

        for (const endpoint of endpoints) {
            const response = await fetchServerJSON(params.serverId, endpoint);
            if (!response.ok) {
                lastError = response.error || lastError;
                continue;
            }

            const threads = extractThreads(response.data);
            if (threads.length) {
                collected = collected.concat(threads);
            }
        }

        if (!collected.length && lastError) {
            return {kind: this.kind, items: [], error: lastError};
        }

        const channelsMap = new Map<string, ChannelRecord>();
        const channelsResponse = await fetchServerJSONCached(params.serverId, '/api/v4/users/me/channels');
        if (channelsResponse.ok && Array.isArray(channelsResponse.data)) {
            channelsResponse.data.
                filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')).
                forEach((entry) => {
                    const channelId = String(entry.id || '');
                    if (!channelId) {
                        return;
                    }
                    channelsMap.set(channelId, {
                        id: channelId,
                        display_name: String(entry.display_name || ''),
                        name: String(entry.name || ''),
                    });
                });
        }

        const actorIds = Array.from(new Set(
            collected.
                map((thread) => extractThreadActorUserId(thread)).
                filter((id): id is string => Boolean(id)),
        ));
        const userMap = new Map<string, UserRecord>();
        await Promise.all(actorIds.map(async (actorId) => {
            const response = await fetchServerJSONCached(params.serverId, `/api/v4/users/${encodeURIComponent(actorId)}`);
            if (response.ok && response.data && typeof response.data === 'object') {
                userMap.set(actorId, response.data as UserRecord);
            }
        }));

        const mentionNameCache = new Map<string, string | null>();
        const selfUsername = await getCurrentUserUsername(params.serverId, params.userId);
        const items = await Promise.all(collected.map(async (thread) => {
                const actorId = extractThreadActorUserId(thread);
                const channelId = extractThreadChannelId(thread);
                const normalized = normalizeThreadReply(
                    params.serverId,
                    params.userId,
                    thread,
                    formatUserDisplayName(actorId ? userMap.get(actorId) : undefined),
                    formatChannelDisplayName(channelsMap.get(channelId)),
                );
                const mentionRender = await replaceMentionUsernamesWithDisplayNames(
                    params.serverId,
                    normalized.previewText,
                    mentionNameCache,
                    selfUsername,
                );
                normalized.previewText = mentionRender.text;
                normalized.sourceRef = {
                    ...(normalized.sourceRef || {}),
                    personalMention: mentionRender.hasPersonalMention ? 'true' : '',
                    broadcastMention: mentionRender.hasBroadcastMention ? 'true' : '',
                };
                return normalized;
            }));

        const filteredItems = items.
            filter((item) => item.actorUserId !== params.userId).
            filter((item) => item.eventTs >= params.sinceMs).
            filter((item) => !params.beforeMs || item.eventTs < params.beforeMs);

        return {
            kind: this.kind,
            items: filteredItems,
            nextCursor: String(params.page + 1),
        };
    }
}
