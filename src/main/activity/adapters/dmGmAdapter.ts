// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';

import {fetchServerJSON, getUserAvatarURL} from '../activityAPI';
import {forEachWithConcurrency} from '../concurrency';
import {getCurrentUserUsername} from '../mentionDisplay';

// Feature toggle: hide own DM/GM messages from Activity feed.
const HIDE_MESSAGES_FROM_ME = true;
const MAX_DM_GM_CHANNELS_PER_REFRESH = 10;
const MAX_DM_GM_POSTS_PER_CHANNEL = 5;
const DM_GM_FETCH_CONCURRENCY = 4;
const HIDDEN_DM_SYSTEM_MESSAGE_PATTERNS = [
    /\bmarked\b.*\bas complete\b/i,
];

type ChannelRecord = {
    id: string;
    type: string;
    display_name?: string;
    name?: string;
    update_at?: number;
    last_post_at?: number;
};

type UserRecord = {
    id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
};

type PostRecord = {
    id: string;
    user_id?: string;
    message?: string;
    create_at?: number;
    update_at?: number;
};

function normalizeMessageForComparison(message: string): string {
    return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isHiddenReminderCompletionDMMessage(post: PostRecord, channelType: string): boolean {
    if (channelType !== 'D') {
        return false;
    }

    const normalizedMessage = normalizeMessageForComparison(post.message || '');
    return HIDDEN_DM_SYSTEM_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

function getChannelActivityTs(channel: ChannelRecord): number {
    return Number(channel.last_post_at || channel.update_at || 0);
}

function getPostActivityTs(post: PostRecord): number {
    return Number(post.create_at || post.update_at || 0);
}

function formatPersonName(user?: UserRecord): string {
    if (!user) {
        return '';
    }

    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    return fullName || user.username || '';
}

type NormalizedChannelPostActivityParams = {
    serverId: string;
    userId: string;
    channel: ChannelRecord;
    kind: 'dm' | 'gm';
    post: PostRecord;
    actorName: string;
    participantNames: string[];
};

async function fetchUserById(serverId: string, userId: string, userCache: Map<string, Promise<UserRecord | null>>) {
    if (!userId) {
        return null;
    }

    const cached = userCache.get(userId);
    if (cached) {
        return cached;
    }

    const request = (async () => {
        const response = await fetchServerJSON(serverId, `/api/v4/users/${userId}`);
        if (!response.ok || !response.data || typeof response.data !== 'object') {
            return null;
        }

        return response.data as UserRecord;
    })();
    userCache.set(userId, request);
    return request;
}

async function fetchChannelPosts(serverId: string, channelId: string, page: number, perPage: number) {
    const response = await fetchServerJSON(serverId, `/api/v4/channels/${channelId}/posts?page=${page}&per_page=${perPage}`);
    if (!response.ok) {
        return [];
    }

    const typed = response.data as Record<string, unknown>;
    const order = Array.isArray(typed?.order) ? typed.order.map(String) : [];
    const posts = (typed?.posts || {}) as Record<string, unknown>;
    return order.
        map((id) => posts[id]).
        filter((post): post is PostRecord => Boolean(post && typeof post === 'object')).
        map((post) => ({...post, id: String(post.id || '')})).
        filter((post) => Boolean(post.id));
}

function normalizeChannelPostActivity({
    serverId,
    userId,
    channel,
    kind,
    post,
    actorName,
    participantNames,
}: NormalizedChannelPostActivityParams): ActivityItem {
    const eventTs = Number(post.create_at || post.update_at || channel.last_post_at || channel.update_at || 0);
    const message = (post.message || '').trim();

    let previewText = '';
    if (kind === 'dm') {
        const dmPeer = participantNames[0] || channel.display_name || 'Direct message';
        if (message) {
            previewText = `${actorName || dmPeer}: ${message}`;
        } else {
            previewText = `Direct message with ${dmPeer}`;
        }
    } else if (message) {
        previewText = `${actorName || 'Member'}: ${message}`;
    } else {
        previewText = `Group message with ${participantNames.join(', ') || channel.display_name || channel.id}`;
    }

    const actorUserId = post.user_id;

    return {
        canonicalId: '',
        eventKind: kind,
        serverId,
        targetUserId: userId,
        eventTs,
        previewText,
        channelId: channel.id,
        postId: post.id,
        actorUserId,
        actorAvatarUrl: getUserAvatarURL(serverId, actorUserId),
        sourceRef: {
            channelId: channel.id,
            postId: post.id,
            actorName: actorName || '',
            groupMembers: participantNames.join(', '),
        },
    };
}

export class DMGMAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'dm';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        const endpoint = '/api/v4/users/me/channels';
        const response = await fetchServerJSON(params.serverId, endpoint);
        if (!response.ok) {
            return {kind: this.kind, items: [], error: response.error};
        }

        const channels = Array.isArray(response.data) ? response.data : [];
        const records = channels.filter((channel): channel is ChannelRecord => {
            return Boolean(channel && typeof channel === 'object' && (channel as ChannelRecord).id && (channel as ChannelRecord).type);
        }).
            filter((channel) => channel.type === 'D' || channel.type === 'G').
            filter((channel) => getChannelActivityTs(channel) >= params.sinceMs).
            sort((a, b) => getChannelActivityTs(b) - getChannelActivityTs(a)).
            slice(0, MAX_DM_GM_CHANNELS_PER_REFRESH);

        const userCache = new Map<string, Promise<UserRecord | null>>();
        const selfUsername = await getCurrentUserUsername(params.serverId, params.userId);
        const normalizedSelfUsername = selfUsername.toLowerCase();
        const items = [] as ActivityItem[];
        let hasMore = false;

        await forEachWithConcurrency(records, DM_GM_FETCH_CONCURRENCY, async (channel) => {
            const postsPerChannel = Math.min(params.pageSize, MAX_DM_GM_POSTS_PER_CHANNEL);
            const posts = await fetchChannelPosts(params.serverId, channel.id, params.page, postsPerChannel);
            if (posts.length >= postsPerChannel) {
                hasMore = true;
            }

            const relevantPosts = posts.
                filter((post) => getPostActivityTs(post) >= params.sinceMs).
                filter((post) => !params.beforeMs || getPostActivityTs(post) < params.beforeMs).
                filter((post) => !HIDE_MESSAGES_FROM_ME || post.user_id !== params.userId).
                filter((post) => !isHiddenReminderCompletionDMMessage(post, channel.type));
            if (!relevantPosts.length) {
                return;
            }

            await Promise.all(relevantPosts.map(async (post) => {
                const actor = post.user_id ? await fetchUserById(params.serverId, post.user_id, userCache) : null;
                const actorName = formatPersonName(actor || undefined);
                const message = post.message || '';
                const normalizedItem = normalizeChannelPostActivity({
                    serverId: params.serverId,
                    userId: params.userId,
                    channel,
                    kind: channel.type === 'D' ? 'dm' : 'gm',
                    post,
                    actorName,
                    participantNames: [],
                });
                normalizedItem.sourceRef = {
                    ...(normalizedItem.sourceRef || {}),
                    personalMention: normalizedSelfUsername && message.toLowerCase().includes(`@${normalizedSelfUsername}`) ? 'true' : '',
                    broadcastMention: (/(^|[\s(])@(here|all|channel)\b/i).test(message) ? 'true' : '',
                };
                items.push(normalizedItem);
            }));
        });

        const filteredItems = items.
            filter((item) => item.eventTs >= params.sinceMs).
            filter((item) => !params.beforeMs || item.eventTs < params.beforeMs);

        return {
            kind: this.kind,
            items: filteredItems,
            nextCursor: hasMore ? String(params.page + 1) : undefined,
        };
    }
}
