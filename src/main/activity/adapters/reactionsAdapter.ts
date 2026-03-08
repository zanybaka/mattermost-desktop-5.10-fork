// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';
import * as nodeEmoji from 'node-emoji';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';
import {getUnreadActivitySnapshot} from './unreadActivitySnapshot';

import {fetchServerJSONCached, getEmojiImageURL, getUserAvatarURL} from '../activityAPI';

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
        actorUserId,
        actorAvatarUrl: getUserAvatarURL(serverId, actorUserId),
        isUnread: true,
        sourceRef: {
            postId,
            emoji,
            emojiImageUrl: emojiImageUrl || '',
            emojiUnicode: emojiUnicode || '',
        },
    };
}

export class ReactionsAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'reaction';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        if (!params.userId) {
            return {kind: this.kind, items: [], nextCursor: undefined};
        }

        const snapshot = await getUnreadActivitySnapshot(params);
        if (!snapshot.ok) {
            return {kind: this.kind, items: [], error: snapshot.error};
        }

        const {reactionChannelIds: channelIds, postsByChannelId} = snapshot.data;
        console.info('[ReactionsAdapter] unread channel ids', {
            total: channelIds.length,
            sample: channelIds.slice(0, 5),
        });
        const reactions = [] as Array<Record<string, unknown>>;
        for (const channelId of channelIds) {
            const posts = postsByChannelId.get(channelId) || [];
            for (const post of posts) {
                const postId = String(post.id || '');
                const postAuthorId = String(post.user_id || '');
                if (postAuthorId !== params.userId) {
                    continue;
                }

                for (const reaction of extractReactions(post)) {
                    const reactionUserId = String(reaction.user_id || '');
                    if (!reactionUserId || reactionUserId === params.userId) {
                        continue;
                    }

                    reactions.push({
                        ...reaction,
                        post_id: String(reaction.post_id || postId),
                    });
                }
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
            map((reaction) => normalizeReaction(params.serverId, params.userId, reaction, emojiImageUrlsByName)).
            filter((item) => {
                const key = `${item.postId || ''}:${item.actorUserId || ''}:${item.sourceRef?.emoji || ''}:${item.eventTs}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            }).
            filter((item) => item.eventTs >= params.sinceMs).
            filter((item) => !params.beforeMs || item.eventTs < params.beforeMs);

        return {
            kind: this.kind,
            items,
            nextCursor: undefined,
        };
    }
}
