// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';

import {getCurrentUserUsername, replaceMentionUsernamesWithDisplayNames} from '../mentionDisplay';
import {fetchServerJSON, getUserAvatarURL} from '../activityAPI';

// Feature toggle: hide own DM/GM messages from Activity feed.
const HIDE_MESSAGES_FROM_ME = true;
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

function formatPersonName(user?: UserRecord): string {
    if (!user) {
        return '';
    }

    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    return fullName || user.username || '';
}

type ChannelMemberRecord = {
    user_id?: string;
};

type NormalizedChannelPostActivityParams = {
    serverId: string;
    userId: string;
    channel: ChannelRecord;
    kind: 'dm' | 'gm';
    post: PostRecord;
    actorName: string;
    participantNames: string[];
};

async function fetchUserById(serverId: string, userId: string, userCache: Map<string, UserRecord | null>) {
    if (!userId) {
        return null;
    }

    if (userCache.has(userId)) {
        return userCache.get(userId) || null;
    }

    const response = await fetchServerJSON(serverId, `/api/v4/users/${userId}`);
    if (!response.ok || !response.data || typeof response.data !== 'object') {
        userCache.set(userId, null);
        return null;
    }

    const user = response.data as UserRecord;
    userCache.set(userId, user);
    return user;
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

async function fetchChannelMemberIds(serverId: string, channelId: string) {
    const response = await fetchServerJSON(serverId, `/api/v4/channels/${channelId}/members`);
    if (!response.ok || !Array.isArray(response.data)) {
        return [];
    }

    return response.data.
        filter((member): member is ChannelMemberRecord => Boolean(member && typeof member === 'object')).
        map((member) => String(member.user_id || '')).
        filter(Boolean);
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
        });

        const userCache = new Map<string, UserRecord | null>();
        const mentionNameCache = new Map<string, string | null>();
        const selfUsername = await getCurrentUserUsername(params.serverId, params.userId);
        const items = [] as ActivityItem[];
        let hasMore = false;

        await Promise.all(records.map(async (channel) => {
            if (channel.type !== 'D' && channel.type !== 'G') {
                return;
            }

            const memberIds = await fetchChannelMemberIds(params.serverId, channel.id);
            const participantIds = memberIds.filter((id) => id !== params.userId);
            const participants = await Promise.all(participantIds.map((id) => fetchUserById(params.serverId, id, userCache)));
            const participantNames = participants.map((user) => formatPersonName(user || undefined)).filter(Boolean);
            const posts = await fetchChannelPosts(params.serverId, channel.id, params.page, params.pageSize);
            if (posts.length >= params.pageSize) {
                hasMore = true;
            }

            await Promise.all(posts.map(async (post) => {
                if (HIDE_MESSAGES_FROM_ME && post.user_id === params.userId) {
                    return;
                }
                if (isHiddenReminderCompletionDMMessage(post, channel.type)) {
                    return;
                }

                const mentionRender = await replaceMentionUsernamesWithDisplayNames(
                    params.serverId,
                    post.message || '',
                    mentionNameCache,
                    selfUsername,
                );
                const actor = post.user_id ? await fetchUserById(params.serverId, post.user_id, userCache) : null;
                const actorName = formatPersonName(actor || undefined);
                const normalizedItem = normalizeChannelPostActivity({
                    serverId: params.serverId,
                    userId: params.userId,
                    channel,
                    kind: channel.type === 'D' ? 'dm' : 'gm',
                    post: {
                        ...post,
                        message: mentionRender.text,
                    },
                    actorName,
                    participantNames,
                });
                normalizedItem.sourceRef = {
                    ...(normalizedItem.sourceRef || {}),
                    personalMention: mentionRender.hasPersonalMention ? 'true' : '',
                    broadcastMention: mentionRender.hasBroadcastMention ? 'true' : '',
                };
                items.push(normalizedItem);
            }));
        }));

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
