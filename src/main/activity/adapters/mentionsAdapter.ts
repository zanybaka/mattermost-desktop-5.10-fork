// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';
import {getUnreadActivitySnapshot} from './unreadActivitySnapshot';

import {getCurrentUserUsername, replaceMentionUsernamesWithDisplayNames} from '../mentionDisplay';
import {fetchServerJSONCached, getUserAvatarURL} from '../activityAPI';

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
    type?: string;
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

function getString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function extractMentionPreview(post: Record<string, unknown>): string {
    const message = getString(post.message).trim();
    if (message) {
        return message;
    }

    const props = (post.props && typeof post.props === 'object') ? post.props as Record<string, unknown> : undefined;
    if (props) {
        const directLink = getString(props.permalink) || getString(props.link) || getString(props.url);
        if (directLink) {
            return directLink;
        }

        const attachments = Array.isArray(props.attachments) ? props.attachments : [];
        for (const attachment of attachments) {
            if (!attachment || typeof attachment !== 'object') {
                continue;
            }
            const typedAttachment = attachment as Record<string, unknown>;
            const candidate = getString(typedAttachment.original_url) || getString(typedAttachment.title_link) || getString(typedAttachment.url);
            if (candidate) {
                return candidate;
            }
        }
    }

    const metadata = (post.metadata && typeof post.metadata === 'object') ? post.metadata as Record<string, unknown> : undefined;
    const embeds = Array.isArray(metadata?.embeds) ? metadata.embeds : [];
    for (const embed of embeds) {
        if (!embed || typeof embed !== 'object') {
            continue;
        }
        const typedEmbed = embed as Record<string, unknown>;
        const candidate = getString(typedEmbed.url);
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function normalizeMention(serverId: string, userId: string, post: Record<string, unknown>, actorName = '', channelName = ''): ActivityItem {
    const postId = String(post.id || '');
    const updateAt = Number(post.update_at || post.create_at || Date.now());
    const previewText = extractMentionPreview(post);
    const channelId = String(post.channel_id || '');
    const rootId = String(post.root_id || '');
    const user = String(post.user_id || '');
    const actorUserId = user || undefined;

    return {
        canonicalId: '',
        eventKind: 'mention',
        serverId,
        targetUserId: userId,
        eventTs: updateAt,
        previewText,
        postId,
        channelId: channelId || undefined,
        threadId: rootId || undefined,
        actorUserId,
        actorAvatarUrl: getUserAvatarURL(serverId, actorUserId),
        isUnread: true,
        sourceRef: {
            postId,
            channelId,
            actorName: actorName || '',
            channelName: channelName || '',
            linkUrl: previewText.startsWith('http://') || previewText.startsWith('https://') ? previewText : '',
        },
    };
}

async function fetchMentionPostsFromUnread(params: AdapterFetchParams): Promise<ActivityItem[]> {
    if (!params.userId) {
        return [];
    }

    const snapshot = await getUnreadActivitySnapshot(params);
    if (!snapshot.ok) {
        return [];
    }
    const {mentionChannelIds: channelIds, postsByChannelId, channelsById} = snapshot.data;
    console.info('[MentionsAdapter] unread channel ids', {
        total: channelIds.length,
        sample: channelIds.slice(0, 5),
    });
    if (!channelIds.length) {
        return [];
    }

    const posts = channelIds.flatMap((channelId) => postsByChannelId.get(channelId) || []);

    const actorIds = Array.from(new Set(posts.map((post) => String(post.user_id || '')).filter(Boolean)));
    const userMap = new Map<string, UserRecord>();
    const mentionNameCache = new Map<string, string | null>();
    const selfUsername = await getCurrentUserUsername(params.serverId, params.userId);
    await Promise.all(actorIds.map(async (actorId) => {
        const response = await fetchServerJSONCached(params.serverId, `/api/v4/users/${encodeURIComponent(actorId)}`);
        if (response.ok && response.data && typeof response.data === 'object') {
            userMap.set(actorId, response.data as UserRecord);
        }
    }));

    const seen = new Set<string>();
    const normalizedItems = await Promise.all(posts.
        filter((post) => {
            const channelId = String(post.channel_id || '');
            const channel = channelsById.get(channelId);
            return channel?.type !== 'D';
        }).
        map(async (post) => {
            const actorId = String(post.user_id || '');
            const channelId = String(post.channel_id || '');
            const normalized = normalizeMention(
                params.serverId,
                params.userId,
                post,
                formatUserDisplayName(userMap.get(actorId)),
                formatChannelDisplayName(channelsById.get(channelId)),
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

    return normalizedItems.
        filter((item) => {
            if (!item.postId || seen.has(item.postId)) {
                return false;
            }
            seen.add(item.postId);
            return true;
        }).
        filter((item) => item.actorUserId !== params.userId).
        filter((item) => item.eventTs >= params.sinceMs).
        filter((item) => !params.beforeMs || item.eventTs < params.beforeMs);
}

export class MentionsAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'mention';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        const items = await fetchMentionPostsFromUnread(params);
        return {
            kind: this.kind,
            items,
            nextCursor: undefined,
        };
    }
}
