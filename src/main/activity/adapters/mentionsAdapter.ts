// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from 'common/activity/types';

import type {ActivitySourceAdapter, AdapterFetchParams, AdapterFetchResult} from './types';

import {fetchServerJSON, fetchServerJSONCached, getUserAvatarURL, postServerJSON} from '../activityAPI';
import {getCurrentUserUsername, replaceMentionUsernamesWithDisplayNames} from '../mentionDisplay';

type UserRecord = {
    id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    notify_props?: Record<string, string>;
};

type ChannelRecord = {
    id: string;
    display_name?: string;
    name?: string;
    type?: string;
};

type MentionSearchOptions = {
    useSearchMentions: boolean;
    terms: string;
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

function buildMentionSearchTerms(user: UserRecord): string {
    const keys: string[] = [];
    const username = (user.username || '').trim();
    if (username) {
        keys.push(`@${username}`);
    }

    const notifyProps = user.notify_props || {};
    if (notifyProps.first_name === 'true' && user.first_name?.trim()) {
        keys.push(user.first_name.trim());
    }

    const mentionKeys = (notifyProps.mention_keys || '').
        split(',').
        map((key) => key.trim()).
        filter(Boolean);
    for (const key of mentionKeys) {
        const normalized = key.toLowerCase();
        if (normalized === '@channel' || normalized === '@all' || normalized === '@here' ||
            normalized === 'channel' || normalized === 'all' || normalized === 'here') {
            continue;
        }
        keys.push(key.startsWith('@') ? key : `@${key}`);
    }

    const uniqueKeys = Array.from(new Set(keys));
    return uniqueKeys.map((key) => `"${key}"`).join(' ');
}

async function searchFallbackMentionPosts(
    params: AdapterFetchParams,
    user: UserRecord,
): Promise<{posts: Array<Record<string, unknown>>; error?: string}> {
    const personalTerms = buildMentionSearchTerms(user);
    const queries = [
        personalTerms,
        ...(user.notify_props?.channel === 'true' ? ['"@channel"', '"@all"', '"@here"'] : []),
    ].filter(Boolean);
    const postsById = new Map<string, Record<string, unknown>>();
    const results = await Promise.all(queries.map((terms) => (
        searchMentionPosts(params, {useSearchMentions: false, terms})
    )));
    results.forEach((result) => {
        result.posts.forEach((post) => {
            const postId = String(post.id || '');
            if (postId) {
                postsById.set(postId, post);
            }
        });
    });

    const posts = Array.from(postsById.values());
    return {
        posts,
        error: posts.length ? undefined : results.find((result) => result.error)?.error,
    };
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

function buildSearchBody(params: AdapterFetchParams, options: MentionSearchOptions) {
    const perPage = Math.max(10, Math.min(params.pageSize, 100));
    const body: Record<string, unknown> = {
        terms: options.terms,
        is_or_search: true,
        include_deleted_channels: true,
        time_zone_offset: -new Date().getTimezoneOffset() * 60,
        page: params.page,
        per_page: perPage,
    };
    if (options.useSearchMentions) {
        body.search_mentions = true;
    }
    return body;
}

async function searchMentionPosts(
    params: AdapterFetchParams,
    options: MentionSearchOptions,
): Promise<{posts: Array<Record<string, unknown>>; error?: string}> {
    const body = buildSearchBody(params, options);
    const globalResponse = await postServerJSON(params.serverId, '/api/v4/posts/search', body);
    if (globalResponse.ok) {
        return {posts: getPostsFromPayload(globalResponse.data)};
    }
    if (options.useSearchMentions) {
        return {posts: [], error: globalResponse.error};
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

async function loadChannelsById(serverId: string): Promise<Map<string, ChannelRecord>> {
    const channelsById = new Map<string, ChannelRecord>();
    const channelsResponse = await fetchServerJSONCached(serverId, '/api/v4/users/me/channels');
    if (!channelsResponse.ok || !Array.isArray(channelsResponse.data)) {
        return channelsById;
    }

    channelsResponse.data.
        filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')).
        forEach((entry) => {
            const channelId = String(entry.id || '');
            if (!channelId) {
                return;
            }
            channelsById.set(channelId, {
                id: channelId,
                display_name: String(entry.display_name || ''),
                name: String(entry.name || ''),
                type: String(entry.type || ''),
            });
        });

    return channelsById;
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
    const eventTs = Number(post.create_at || post.update_at || Date.now());
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
        eventTs,
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

async function fetchMentionPosts(params: AdapterFetchParams): Promise<{items: ActivityItem[]; error?: string}> {
    if (!params.userId) {
        return {items: []};
    }

    let searchResult = await searchMentionPosts(params, {useSearchMentions: true, terms: ''});
    if (!searchResult.posts.length) {
        const userResponse = await fetchServerJSONCached(params.serverId, `/api/v4/users/${encodeURIComponent(params.userId)}`);
        let user: UserRecord | undefined;
        if (userResponse.ok && userResponse.data && typeof userResponse.data === 'object') {
            user = userResponse.data as UserRecord;
        }
        if (user) {
            searchResult = await searchFallbackMentionPosts(params, user);
        }
    }

    const {posts, error} = searchResult;
    if (!posts.length) {
        return {items: [], error};
    }

    const channelsById = await loadChannelsById(params.serverId);
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

    const items = normalizedItems.
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

    return {items, error};
}

export class MentionsAdapter implements ActivitySourceAdapter {
    kind: AdapterFetchResult['kind'] = 'mention';

    async fetch(params: AdapterFetchParams): Promise<AdapterFetchResult> {
        const {items, error} = await fetchMentionPosts(params);
        const perPage = Math.max(10, Math.min(params.pageSize, 100));
        return {
            kind: this.kind,
            items,
            nextCursor: items.length >= perPage ? String(params.page + 1) : undefined,
            error,
        };
    }
}
