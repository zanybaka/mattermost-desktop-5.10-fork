// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {dedupeActivityItems, withCanonicalId} from './canonical';
import type {ActivityItem} from './types';

const EVENT_KIND_PRIORITY: Record<ActivityItem['eventKind'], number> = {
    mention: 1,
    thread_reply: 2,
    dm: 3,
    gm: 4,
    reaction: 5,
    reminder: 6,
};

export function compareActivityItems(a: ActivityItem, b: ActivityItem): number {
    if (a.eventTs !== b.eventTs) {
        return b.eventTs - a.eventTs;
    }

    if (a.eventKind !== b.eventKind) {
        return EVENT_KIND_PRIORITY[a.eventKind] - EVENT_KIND_PRIORITY[b.eventKind];
    }

    return a.canonicalId.localeCompare(b.canonicalId);
}

export function mergeActivityItems(existing: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
    const merged = [...existing, ...incoming].map(withCanonicalId);
    const deduped = dedupeActivityItems(merged);
    return deduped.sort(compareActivityItems);
}
