// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ActivityItem, ActivityPage, PersistedActivityState} from './types';

export type ActivityLoadContext = {
    serverId: string;
    userId: string;
    pageSize?: number;
    nowMs?: number;
};

export interface ActivityAggregationService {
    loadInitial(context: ActivityLoadContext): Promise<ActivityPage>;
    loadOlder(context: ActivityLoadContext, state: PersistedActivityState): Promise<ActivityPage>;
    refresh(context: ActivityLoadContext, state?: PersistedActivityState): Promise<ActivityPage>;
    searchLocal(query: string, items: ActivityItem[]): ActivityItem[];
}
