// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {PersistedActivityState} from './types';

export const ACTIVITY_PERSISTENCE_VERSION = 1;

type PersistedEnvelopeV1 = {
    version: 1;
    payload: PersistedActivityState;
};

export function serializePersistedActivityState(state: PersistedActivityState): string {
    const envelope: PersistedEnvelopeV1 = {
        version: ACTIVITY_PERSISTENCE_VERSION,
        payload: state,
    };

    return JSON.stringify(envelope);
}

export function deserializePersistedActivityState(raw: string): PersistedActivityState | null {
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedEnvelopeV1>;
        if (parsed.version !== ACTIVITY_PERSISTENCE_VERSION || !parsed.payload) {
            return null;
        }

        const {payload} = parsed;
        if (!payload.serverId || typeof payload.fetchedAt !== 'number') {
            return null;
        }

        return {
            serverId: payload.serverId,
            fetchedAt: payload.fetchedAt,
            uiCursor: payload.uiCursor,
            sourceCursors: payload.sourceCursors || {},
            checkpoint: payload.checkpoint || {watermarkTs: 0, mergeSequence: 0},
            items: payload.items || [],
        };
    } catch {
        return null;
    }
}
