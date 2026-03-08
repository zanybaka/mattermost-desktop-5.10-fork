// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {PersistedActivityState} from 'common/activity/types';

class ActivityStateStore {
    private state = new Map<string, PersistedActivityState>();

    get(serverId: string) {
        return this.state.get(serverId);
    }

    set(state: PersistedActivityState) {
        this.state.set(state.serverId, state);
    }

    delete(serverId: string) {
        this.state.delete(serverId);
    }

    clear() {
        this.state.clear();
    }
}

const activityStateStore = new ActivityStateStore();
export default activityStateStore;
