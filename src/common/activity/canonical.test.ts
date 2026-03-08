// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {dedupeActivityItems, toCanonicalId, withCanonicalId} from './canonical';
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

describe('activity canonical helpers', () => {
    test('builds reminder canonical id from reminder id', () => {
        const item = makeItem({
            eventKind: 'reminder',
            reminderId: 'rem-123',
        });

        expect(toCanonicalId(item)).toBe('reminder:reminder:rem-123');
    });

    test('keeps different post event kinds separate', () => {
        const mention = makeItem({
            eventKind: 'mention',
            postId: 'post-1',
            eventTs: 100,
        });
        const reaction = makeItem({
            eventKind: 'reaction',
            postId: 'post-1',
            eventTs: 200,
        });

        const deduped = dedupeActivityItems([mention, reaction]);
        expect(deduped).toHaveLength(2);
        expect(deduped.map((item) => item.eventKind).sort()).toEqual(['mention', 'reaction']);
    });

    test('does not dedupe different reminders', () => {
        const first = makeItem({
            eventKind: 'reminder',
            reminderId: 'rem-1',
        });
        const second = makeItem({
            eventKind: 'reminder',
            reminderId: 'rem-2',
        });

        expect(dedupeActivityItems([first, second])).toHaveLength(2);
    });

    test('fills missing canonical id', () => {
        const item = makeItem({
            eventKind: 'dm',
            channelId: 'chan-1',
            sourceRef: {id: 'src-1'},
        });

        const result = withCanonicalId(item);
        expect(result.canonicalId).toContain('dm:');
    });
});
