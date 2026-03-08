// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {deserializePersistedActivityState, serializePersistedActivityState} from './persistence';
import type {PersistedActivityState} from './types';

function makeState(overrides: Partial<PersistedActivityState>): PersistedActivityState {
    return {
        serverId: 'server-1',
        fetchedAt: 123,
        sourceCursors: {},
        checkpoint: {watermarkTs: 0, mergeSequence: 0},
        items: [],
        ...overrides,
    };
}

describe('activity persistence', () => {
    test('serializes and deserializes persisted state', () => {
        const state = makeState({uiCursor: 'cursor-1'});
        const raw = serializePersistedActivityState(state);

        expect(deserializePersistedActivityState(raw)).toEqual(state);
    });

    test('returns null for unsupported version', () => {
        const unsupported = JSON.stringify({
            version: 99,
            payload: makeState({}),
        });

        expect(deserializePersistedActivityState(unsupported)).toBeNull();
    });

    test('returns null for malformed payload', () => {
        expect(deserializePersistedActivityState('not-json')).toBeNull();
    });
});
