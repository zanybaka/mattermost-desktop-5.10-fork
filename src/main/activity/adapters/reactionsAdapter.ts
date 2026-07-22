// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import * as nodeEmoji from 'node-emoji';

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';

import {fetchServerJSON, fetchServerJSONCached, getEmojiImageURL, getUserAvatarURL, postServerJSON} from '../activityAPI';
import {getCurrentUserUsername} from '../mentionDisplay';

const MAX_SEARCH_PAGES = 10;
const SEARCH_PER_PAGE = 100;

function extractReactions(post: Record<string, unknown>): Array<Record<string, unknown>> {
    const metadata = post.metadata;
    if (!metadata || typeof metadata !== 'object') {
        return [];
    }

    const reactions = (metadata as Record<string, unknown>).reactions;
    if (!Array.isArray(reactions)) {
        return [];
    }

    return reactions.filter((reaction): reaction is Record<string, unknown> => Boolean(reaction && typeof reaction === 'object'));
}

function getPostsFromPayload(payload: unknown): Array<Record<string, unknown>> {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload.filter((post): post is Record<string, unknown> => Boolean(post && typeof post === 'object'));
    }

    const typed = payload as Record<string, unknown>;
    const order = Array.isArray(typed.order) ? typed.order.map(String) : [];
    const posts = (typed.posts || {}) as Record<string, unknown>;
    if (!order.length) {
        return [];
    }

    return order.
        map((id) => posts[id]).
        filter((post): post is Record<string, unknown> => Boolean(post && typeof post === 'object'));
}

function formatSearchAfterDate(sinceMs: number): string {
    const date = new Date(Math.max(0, sinceMs));
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

async function searchOwnPostsPage(
    params: AdapterFetchParams,
    terms: string,
    page: number,
): Promise<{posts: Array<Record<string, unknown>>; error?: string}> {
    const body: Record<string, unknown> = {
        terms,
        is_or_search: true,
        include_deleted_channels: true,
        time_zone_offset: -new Date().getTimezoneOffset() * 60,
        page,
        per_page: SEARCH_PER_PAGE,
    };

    const globalResponse = await postServerJSON(params.serverId, '/api/v4/posts/search', body);
    if (globalResponse.ok) {
        return {posts: getPostsFromPayload(globalResponse.data)};
    }

    const teamIds = await getTeamIds(params.serverId);
    const postsById = new Map<string, Record<string, unknown>>();
    const responses = await Promise.all(teamIds.map((teamId) => (
        postServerJSON(
            params.serverId,
            `/api/v4/teams/${encodeURIComponent(teamId)}/posts/search`,
            body,
        )
    )));
    responses.forEach((response) => {
        if (!response.ok) {
            return;
        }
        getPostsFromPayload(response.data).forEach((post) => {
            const postId = String(post.id || '');
            if (postId) {
                postsById.set(postId, post);
            }
        });
    });

    const posts = Array.from(postsById.values());
    const error = globalResponse.error || responses.find((response) => response.error)?.error;
    if (!posts.length && error) {
        return {posts: [], error};
    }

    return {posts};
}

async function resolveCustomEmojiImageUrls(serverId: string, emojiNames: string[]): Promise<Map<string, string>> {
    const urlsByName = new Map<string, string>();
    await Promise.all(emojiNames.map(async (emojiName) => {
        const endpoint = `/api/v4/emoji/name/${encodeURIComponent(emojiName)}`;
        const response = await fetchServerJSONCached(serverId, endpoint);
        if (!response.ok || !response.data || typeof response.data !== 'object') {
            return;
        }

        const emojiId = String((response.data as Record<string, unknown>).id || '').trim();
        const emojiImageUrl = getEmojiImageURL(serverId, emojiId);
        if (emojiImageUrl) {
            urlsByName.set(emojiName, emojiImageUrl);
        }
    }));

    return urlsByName;
}

function resolveSystemEmojiUnicode(emojiName: string): string | undefined {
    const normalized = emojiName.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    const candidates = [
        normalized,
        normalized.replace(/-/g, '_'),
        normalized.replace(/_/g, '-'),
    ];

    for (const candidate of candidates) {
        const value = nodeEmoji.get(candidate);
        if (value) {
            return value;
        }
    }

    return undefined;
}

function normalizeReaction(
    serverId: string,
    userId: string,
    reaction: Record<string, unknown>,
    emojiImageUrlsByName: Map<string, string>,
    channelId = '',
): ActivityItem {
    const postId = String(reaction.post_id || '');
    const createAt = Number(reaction.create_at || Date.now());
    const actor = String(reaction.user_id || '');
    const actorUserId = actor || undefined;
    const emoji = String(reaction.emoji_name || '').trim() || 'reaction';
    const emojiImageUrl = emojiImageUrlsByName.get(emoji);
    const emojiUnicode = resolveSystemEmojiUnicode(emoji);

    return {
        canonicalId: '',
        eventKind: 'reaction',
        serverId,
        targetUserId: userId,
        eventTs: createAt,
        previewText: emojiUnicode || `:${emoji}:`,
        postId: postId || undefined,
        channelId: channelId || undefined,
        actorUserId,
        actorAvatarUrl: getUserAvatarURL(serverId, actorUserId),
        isUnread: true,
        sourceRef: {
            postId,
            emoji,
            emojiImageUrl: emojiImageUrl || '',
            emojiUnicode: emojiUnicode || '',
            channelId: channelId || '',
        },
    };
}

export class ReactionsAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'reaction';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        if (!params.userId) {
            return {kind: this.kind, items: [], nextCursor: undefined};
        }

        const username = await getCurrentUserUsername(params.serverId, params.userId);
        if (!username) {
            return {kind: this.kind, items: [], error: 'failed to resolve current username'};
        }

        const terms = `from:${username} after:${formatSearchAfterDate(params.sinceMs)}`;
        const postsById = new Map<string, Record<string, unknown>>();
        let firstError: string | undefined;

        for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
            // eslint-disable-next-line no-await-in-loop
            const pageResult = await searchOwnPostsPage(params, terms, page);
            if (pageResult.error && !firstError) {
                firstError = pageResult.error;
            }

            let newCount = 0;
            pageResult.posts.forEach((post) => {
                const postId = String(post.id || '');
                if (!postId || postsById.has(postId)) {
                    return;
                }
                postsById.set(postId, post);
                newCount += 1;
            });

            if (pageResult.posts.length < SEARCH_PER_PAGE || newCount === 0) {
                break;
            }
        }

        if (!postsById.size && firstError) {
            return {kind: this.kind, items: [], error: firstError};
        }

        const reactions = [] as Array<Record<string, unknown> & {channel_id?: string}>;
        for (const post of postsById.values()) {
            const postId = String(post.id || '');
            const postAuthorId = String(post.user_id || '');
            if (postAuthorId !== params.userId) {
                continue;
            }

            const channelId = String(post.channel_id || '');
            for (const reaction of extractReactions(post)) {
                const reactionUserId = String(reaction.user_id || '');
                if (!reactionUserId || reactionUserId === params.userId) {
                    continue;
                }

                reactions.push({
                    ...reaction,
                    post_id: String(reaction.post_id || postId),
                    channel_id: channelId,
                });
            }
        }

        const seen = new Set<string>();
        const emojiNames = Array.from(new Set(
            reactions.
                map((reaction) => String(reaction.emoji_name || '').trim()).
                filter(Boolean),
        ));
        const emojiImageUrlsByName = await resolveCustomEmojiImageUrls(params.serverId, emojiNames);
        const items = reactions.
            map((reaction) => normalizeReaction(
                params.serverId,
                params.userId,
                reaction,
                emojiImageUrlsByName,
                String(reaction.channel_id || ''),
            )).
            filter((item) => {
                const key = `${item.postId || ''}:${item.actorUserId || ''}:${item.sourceRef?.emoji || ''}:${item.eventTs}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            }).
            filter((item) => item.eventTs >= params.sinceMs).
            filter((item) => !params.beforeMs || item.eventTs < params.beforeMs).
            sort((a, b) => b.eventTs - a.eventTs);

        return {
            kind: this.kind,
            items,
            nextCursor: undefined,
        };
    }
}
