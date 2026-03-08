// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export type ActivityEventKind = 'mention' | 'thread_reply' | 'reaction' | 'dm' | 'gm' | 'reminder';

export type ActivitySourceCursorMap = Partial<Record<ActivityEventKind, string>>;

export type ActivityCheckpoint = {
    watermarkTs: number;
    mergeSequence: number;
    windowStartTs?: number;
    visibleSinceMs?: number;
};

export type ActivitySourceError = {
    source: ActivityEventKind;
    message: string;
    retriable: boolean;
};

export type ActivityItem = {
    canonicalId: string;
    eventKind: ActivityEventKind;
    serverId: string;
    targetUserId: string;
    eventTs: number;
    previewText: string;
    postId?: string;
    reminderId?: string;
    channelId?: string;
    threadId?: string;
    actorUserId?: string;
    actorAvatarUrl?: string;
    isUnread?: boolean;
    sourceRef?: Record<string, string>;
};

export type ActivityPage = {
    items: ActivityItem[];
    uiCursor?: string;
    sourceCursors: ActivitySourceCursorMap;
    checkpoint: ActivityCheckpoint;
    errors: ActivitySourceError[];
    hasMore: boolean;
};

export type PersistedActivityState = {
    serverId: string;
    fetchedAt: number;
    uiCursor?: string;
    sourceCursors: ActivitySourceCursorMap;
    checkpoint: ActivityCheckpoint;
    items: ActivityItem[];
};
