// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityEventKind, ActivityItem} from 'common/activity/types';

export type AdapterFetchParams = {
    serverId: string;
    userId: string;
    pageSize: number;
    page: number;
    sinceMs: number;
    beforeMs?: number;
};

export type AdapterFetchResult = {
    kind: ActivityEventKind;
    items: ActivityItem[];
    nextCursor?: string;
    error?: string;
};

export interface ActivitySourceAdapter {
    kind: ActivityEventKind;
    fetch(params: AdapterFetchParams): Promise<AdapterFetchResult>;
}
