// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem} from './types';

function getStableSourceKey(item: ActivityItem): string {
    if (item.eventKind === 'reminder' && item.reminderId) {
        return `reminder:${item.reminderId}`;
    }

    if (item.postId) {
        // Collapse post-based events into a single logical card key.
        return `post:${item.postId}`;
    }

    if (item.threadId) {
        return `thread:${item.threadId}`;
    }

    if (item.sourceRef && item.sourceRef.id) {
        return `source:${item.sourceRef.id}`;
    }

    return 'unknown';
}

export function toCanonicalId(item: ActivityItem): string {
    return `${item.eventKind}:${getStableSourceKey(item)}`;
}

function toDedupKey(item: ActivityItem): string {
    if (item.eventKind === 'reminder' && item.reminderId) {
        return `reminder:${item.reminderId}`;
    }

    if (item.postId) {
        // Keep mention/reaction/thread cards independent for the same post.
        return `${item.eventKind}:post:${item.postId}`;
    }

    return toCanonicalId(item);
}

export function withCanonicalId(item: ActivityItem): ActivityItem {
    return {
        ...item,
        canonicalId: item.canonicalId || toCanonicalId(item),
    };
}

export function dedupeActivityItems(items: ActivityItem[]): ActivityItem[] {
    const byKey = new Map<string, ActivityItem>();

    for (const rawItem of items) {
        const item = withCanonicalId(rawItem);
        const key = toDedupKey(item);
        const prev = byKey.get(key);

        if (!prev) {
            byKey.set(key, item);
            continue;
        }

        if (item.eventTs > prev.eventTs) {
            byKey.set(key, item);
            continue;
        }

        if (item.eventTs === prev.eventTs && item.canonicalId > prev.canonicalId) {
            byKey.set(key, item);
        }
    }

    return Array.from(byKey.values());
}
