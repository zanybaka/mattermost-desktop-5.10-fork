// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {DMGMAdapter} from './dmGmAdapter';
import {MentionsAdapter} from './mentionsAdapter';
import {ReactionsAdapter} from './reactionsAdapter';
import {RemindersAdapter} from './remindersAdapter';
import {ThreadsAdapter} from './threadsAdapter';

import {fetchServerJSON, fetchServerJSONCached, postServerJSON} from '../activityAPI';

jest.mock('../activityAPI', () => ({
    fetchServerJSON: jest.fn(),
    fetchServerJSONCached: jest.fn(),
    postServerJSON: jest.fn(),
    getUserAvatarURL: jest.fn(() => undefined),
    getEmojiImageURL: jest.fn(() => undefined),
}));

const defaultParams = {
    serverId: 'server-1',
    userId: 'user-1',
    pageSize: 20,
    page: 0,
    sinceMs: 0,
};

describe('activity adapters', () => {
    const mockAPI = (endpoint: string) => {
        if (endpoint === '/api/v4/users/me/teams/unread?include_collapsed_threads=true') {
            return {ok: true, data: [{team_id: 'team1'}]};
        }
        if (endpoint.includes('/teams/team1/channels/unread')) {
            return {ok: true, data: [{channel_id: 'c1', mention_count: 1, msg_count: 1}]};
        }
        if (endpoint === '/api/v4/users/me/channels') {
            return {
                ok: true,
                data: [
                    {id: 'c1', display_name: 'Town Square', name: 'town-square'},
                    {id: 'd1', type: 'D', display_name: 'dm'},
                    {id: 'g1', type: 'G', display_name: 'gm'},
                ],
            };
        }
        if (endpoint.includes('/channels/c1/posts/unread')) {
            return {
                ok: true,
                data: {
                    order: ['p1'],
                    posts: {
                        p1: {
                            id: 'p1',
                            update_at: 10,
                            create_at: 10,
                            message: 'mention text',
                            channel_id: 'c1',
                            root_id: 'r1',
                            user_id: 'user-1',
                            metadata: {
                                reactions: [{
                                    post_id: 'p1',
                                    create_at: 20,
                                    user_id: 'u2',
                                    emoji_name: 'smile',
                                }],
                            },
                        },
                    },
                },
            };
        }
        if (endpoint === '/api/v4/users/actor') {
            return {ok: true, data: {id: 'actor', username: 'actor'}};
        }
        if (endpoint === '/api/v4/users/user-1') {
            return {ok: true, data: {id: 'user-1', username: 'user-1'}};
        }
        if (endpoint === '/api/v4/users/target-user') {
            return {ok: true, data: {id: 'target-user', username: 'target-user'}};
        }
        if (endpoint === '/api/v4/users/target-user-create-ts') {
            return {ok: true, data: {id: 'target-user-create-ts', username: 'target-user-create-ts'}};
        }
        if (endpoint.includes('/emoji/name/')) {
            return {ok: false, error: 'not found'};
        }
        if (endpoint === '/api/v4/channels/d1/members') {
            return {ok: true, data: [{user_id: 'u2'}, {user_id: 'user-1'}]};
        }
        if (endpoint === '/api/v4/channels/g1/members') {
            return {ok: true, data: [{user_id: 'u2'}, {user_id: 'u3'}, {user_id: 'user-1'}]};
        }
        if (endpoint.startsWith('/api/v4/channels/d1/posts')) {
            return {ok: true, data: {order: ['dp1'], posts: {dp1: {id: 'dp1', user_id: 'u2', message: 'dm msg', create_at: 10}}}};
        }
        if (endpoint.startsWith('/api/v4/channels/g1/posts')) {
            return {ok: true, data: {order: ['gp1'], posts: {gp1: {id: 'gp1', user_id: 'u2', message: 'gm msg', create_at: 11}}}};
        }
        if (endpoint === '/api/v4/users/u2') {
            return {ok: true, data: {id: 'u2', username: 'u2'}};
        }
        if (endpoint === '/api/v4/users/u3') {
            return {ok: true, data: {id: 'u3', username: 'u3'}};
        }
        if (endpoint.includes('/api/v4/users/me/recent_mentions')) {
            return {ok: true, data: []};
        }
        return {ok: true, data: []};
    };

    const mockPostSearch = (postOverrides: Record<string, unknown> = {}) => ({
        ok: true,
        data: {
            order: ['p1'],
            posts: {
                p1: {
                    id: 'p1',
                    update_at: 10,
                    create_at: 10,
                    message: 'mention text',
                    channel_id: 'c1',
                    root_id: 'r1',
                    user_id: 'actor',
                    ...postOverrides,
                },
            },
        },
    });

    beforeEach(() => {
        jest.resetAllMocks();
        jest.mocked(fetchServerJSON).mockImplementation(async (_serverId: string, endpoint: string) => mockAPI(endpoint));
        jest.mocked(fetchServerJSONCached).mockImplementation(async (_serverId: string, endpoint: string) => mockAPI(endpoint));
        jest.mocked(postServerJSON).mockImplementation(async (_serverId: string, endpoint: string) => {
            if (endpoint === '/api/v4/posts/search') {
                return mockPostSearch();
            }
            return {ok: true, data: {order: [], posts: {}}};
        });
    });

    test('mentions adapter normalizes post payloads', async () => {
        const result = await new MentionsAdapter().fetch({
            ...defaultParams,
            userId: 'target-user',
        });
        expect(result.items[0].eventKind).toBe('mention');
        expect(result.items[0].postId).toBe('p1');
    });

    test('mentions adapter uses create_at over update_at for event time', async () => {
        jest.mocked(postServerJSON).mockImplementation(async (_serverId: string, endpoint: string) => {
            if (endpoint === '/api/v4/posts/search') {
                return mockPostSearch({
                    update_at: 200,
                    create_at: 100,
                });
            }
            return {ok: true, data: {order: [], posts: {}}};
        });

        const result = await new MentionsAdapter().fetch({
            ...defaultParams,
            userId: 'target-user-create-ts',
        });
        expect(result.items[0].eventTs).toBe(100);
    });

    test('mentions adapter fallback includes enabled channel-wide mention keys', async () => {
        jest.mocked(fetchServerJSONCached).mockImplementation(async (_serverId: string, endpoint: string) => {
            if (endpoint === '/api/v4/users/target-user') {
                return {
                    ok: true,
                    data: {
                        id: 'target-user',
                        username: 'target-user',
                        notify_props: {channel: 'true'},
                    },
                };
            }
            return mockAPI(endpoint);
        });
        jest.mocked(postServerJSON).mockImplementation(async (_serverId: string, _endpoint: string, body: unknown) => {
            const terms = String((body as Record<string, unknown>).terms || '');
            if (terms === '"@channel"') {
                return mockPostSearch({message: '@channel'});
            }
            return {ok: true, data: {order: [], posts: {}}};
        });

        const result = await new MentionsAdapter().fetch({
            ...defaultParams,
            userId: 'target-user',
        });

        expect(result.items[0].previewText).toBe('@channel');
        expect(jest.mocked(postServerJSON).mock.calls.some((call) => (
            (call[2] as Record<string, unknown>).terms === '"@channel"'
        ))).toBe(true);
    });

    test('threads adapter maps thread payloads', async () => {
        jest.mocked(fetchServerJSON).mockResolvedValue({
            ok: true,
            data: {
                threads: [{
                    id: 't1',
                    post_id: 'p1',
                    channel_id: 'c1',
                    last_reply_at: 12,
                    last_reply_text: 'thread text',
                }],
            },
        });

        const result = await new ThreadsAdapter().fetch(defaultParams);
        expect(result.items[0].eventKind).toBe('thread_reply');
        expect(result.items[0].threadId).toBe('t1');
    });

    test('threads adapter does not use last_viewed_at as event time', async () => {
        jest.mocked(fetchServerJSON).mockResolvedValue({
            ok: true,
            data: {
                threads: [{
                    id: 't1',
                    post_id: 'p1',
                    channel_id: 'c1',
                    last_reply_at: 0,
                    last_viewed_at: 200,
                    post: {
                        create_at: 100,
                    },
                }],
            },
        });

        const result = await new ThreadsAdapter().fetch(defaultParams);
        expect(result.items[0].eventTs).toBe(100);
    });

    test('reactions adapter maps reactions', async () => {
        const result = await new ReactionsAdapter().fetch(defaultParams);
        expect(result.items[0].eventKind).toBe('reaction');
        expect(result.items[0].previewText).toContain('😄');
    });

    test('dmgm adapter maps private channels', async () => {
        const result = await new DMGMAdapter().fetch(defaultParams);
        expect(result.items.map((item) => item.eventKind)).toEqual(['dm', 'gm']);
    });

    test('dmgm adapter hides reminder completion dm system messages by pattern', async () => {
        jest.mocked(fetchServerJSON).mockImplementation(async (_serverId: string, endpoint: string) => {
            if (endpoint.startsWith('/api/v4/channels/d1/posts')) {
                return {
                    ok: true,
                    data: {
                        order: ['dp1'],
                        posts: {
                            dp1: {
                                id: 'dp1',
                                user_id: 'u2',
                                message: 'FYI: I have marked this **message** as complete.',
                                create_at: 10,
                            },
                        },
                    },
                };
            }
            return mockAPI(endpoint);
        });

        const result = await new DMGMAdapter().fetch(defaultParams);
        expect(result.items.some((item) => item.postId === 'dp1')).toBe(false);
    });

    test('reminders adapter maps reminder payloads', async () => {
        jest.mocked(fetchServerJSON).mockResolvedValue({
            ok: true,
            data: [{
                id: 'rem1',
                post_id: 'p2',
                remind_at: 100,
                message: 'remind me',
            }],
        });

        const result = await new RemindersAdapter().fetch(defaultParams);
        expect(result.items[0].eventKind).toBe('reminder');
        expect(result.items[0].reminderId).toBe('rem1');
    });
});
