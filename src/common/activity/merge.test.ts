// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {mergeActivityItems} from './merge';
import type {ActivityItem} from './types';

function makeItem(overrides: Partial<ActivityItem>): ActivityItem {
    return {
        canonicalId: '',
        eventKind: 'mention',
        serverId: 'server-1',
        targetUserId: 'user-1',
        eventTs: 100,
        previewText: 'preview',
        ...overrides,
    };
}

describe('activity merge', () => {
    test('orders by descending timestamp', () => {
        const first = makeItem({postId: '1', eventTs: 200});
        const second = makeItem({postId: '2', eventTs: 100});

        const result = mergeActivityItems([second], [first]);
        expect(result.map((item) => item.postId)).toEqual(['1', '2']);
    });

    test('keeps deterministic order on timestamp ties', () => {
        const mention = makeItem({postId: '1', eventKind: 'mention', eventTs: 100});
        const reminder = makeItem({eventKind: 'reminder', reminderId: 'r-1', eventTs: 100});

        const result = mergeActivityItems([], [reminder, mention]);
        expect(result[0].eventKind).toBe('mention');
        expect(result[1].eventKind).toBe('reminder');
    });

    test('remains stable on repeated merges', () => {
        const existing = [makeItem({postId: 'post-1', eventTs: 100})];
        const incoming = [makeItem({postId: 'post-1', eventTs: 100})];

        const once = mergeActivityItems(existing, incoming);
        const twice = mergeActivityItems(once, incoming);

        expect(once).toEqual(twice);
        expect(twice).toHaveLength(1);
    });
});
