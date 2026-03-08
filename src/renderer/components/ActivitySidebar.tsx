// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import classNames from 'classnames';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FormattedMessage, useIntl} from 'react-intl';

import type {ActivityItem, ActivityPage} from 'common/activity/types';

import '../css/components/ActivitySidebar.scss';

type Props = {
    show: boolean;
    onClose: () => void;
    serverName?: string;
    serverId?: string;
    darkMode: boolean;
};

const HIDDEN_ACTIVITY_STORAGE_KEY_PREFIX = 'mm-desktop-hidden-activity-item-ids';

const EVENT_KIND_ICONS: Record<string, string> = {
    mention: 'icon-at',
    thread_reply: 'icon-reply-outline',
    reaction: 'icon-emoticon-plus-outline',
    dm: 'icon-account-outline',
    gm: 'icon-account-multiple-outline',
    reminder: 'icon-clock-outline',
};

const EVENT_KIND_LABELS: Record<string, string> = {
    mention: 'Mention',
    thread_reply: 'Thread',
    reaction: 'Reaction',
    dm: 'DM',
    gm: 'GM',
    reminder: 'Reminder',
};

function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) {
        return 'now';
    }
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

function getHiddenActivityStorageKey(serverId?: string) {
    return `${HIDDEN_ACTIVITY_STORAGE_KEY_PREFIX}:${(serverId || 'global').trim() || 'global'}`;
}

function getUniqueActivityItemId(item: ActivityItem): string {
    if (item.canonicalId) {
        return item.canonicalId;
    }

    return [
        item.eventKind,
        item.serverId,
        item.targetUserId,
        item.postId || '',
        item.threadId || '',
        item.channelId || '',
        item.reminderId || '',
        item.actorUserId || '',
        String(item.eventTs || 0),
    ].join(':');
}

export default function ActivitySidebar(props: Props) {
    const intl = useIntl();
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [failedAvatarIds, setFailedAvatarIds] = useState<Set<string>>(new Set());
    const [hiddenItemIds, setHiddenItemIds] = useState<Set<string>>(new Set());
    const searchInputRef = useRef<HTMLInputElement>(null);

    const canLoad = Boolean(props.serverId);

    const loadInitial = useCallback(async () => {
        if (!props.serverId) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            const page = await window.desktop.loadActivityInitial({serverId: props.serverId, pageSize: 50}) as ActivityPage;
            setItems(page.items);
            setHasMore(page.hasMore);
            setLastUpdated(Date.now());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [props.serverId]);

    const loadOlder = useCallback(async () => {
        if (!props.serverId || loading) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            const page = await window.desktop.loadActivityOlder({serverId: props.serverId, pageSize: 30}) as ActivityPage;
            setItems(page.items);
            setHasMore(page.hasMore);
            setLastUpdated(Date.now());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [props.serverId, loading]);

    const refresh = useCallback(async () => {
        if (!props.serverId) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            const page = await window.desktop.refreshActivity({serverId: props.serverId, pageSize: 50}) as ActivityPage;
            setItems(page.items);
            setHasMore(page.hasMore);
            setLastUpdated(Date.now());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [props.serverId]);

    const search = useCallback(async () => {
        if (!props.serverId) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            const result = await window.desktop.searchActivityLocal({serverId: props.serverId, query});
            setItems(result);
            setLastUpdated(Date.now());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [props.serverId, query]);

    const clearSearch = useCallback(() => {
        setQuery('');
        loadInitial();
    }, [loadInitial]);

    const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            search();
        }
        if (e.key === 'Escape') {
            if (query) {
                clearSearch();
            } else {
                props.onClose();
            }
        }
    }, [search, query, clearSearch, props.onClose]);

    const openItem = useCallback((item: ActivityItem) => {
        window.desktop.openActivityItem({postId: item.postId, threadId: item.threadId, channelId: item.channelId});
    }, []);

    const persistHiddenItemIds = useCallback((next: Set<string>) => {
        try {
            window.localStorage.setItem(getHiddenActivityStorageKey(props.serverId), JSON.stringify([...next]));
        } catch {
            // Keep the sidebar usable when storage is unavailable.
        }
    }, [props.serverId]);

    const hideItem = useCallback((itemId: string) => {
        setHiddenItemIds((prev) => {
            if (prev.has(itemId)) {
                return prev;
            }
            const next = new Set(prev);
            next.add(itemId);
            persistHiddenItemIds(next);
            return next;
        });
    }, [persistHiddenItemIds]);

    const handleAvatarError = useCallback((canonicalId: string) => {
        setFailedAvatarIds((prev) => {
            if (prev.has(canonicalId)) {
                return prev;
            }
            const next = new Set(prev);
            next.add(canonicalId);
            return next;
        });
    }, []);

    const sortedItems = useMemo(() => {
        return [...items].sort((a, b) => b.eventTs - a.eventTs);
    }, [items]);

    const visibleItems = useMemo(() => {
        return sortedItems.filter((item) => !hiddenItemIds.has(getUniqueActivityItemId(item)));
    }, [sortedItems, hiddenItemIds]);

    useEffect(() => {
        if (!props.show || !props.serverId) {
            return;
        }
        loadInitial();
    }, [props.show, props.serverId, loadInitial]);

    useEffect(() => {
        setFailedAvatarIds(new Set());
        setHasMore(true);
    }, [props.serverId]);

    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(getHiddenActivityStorageKey(props.serverId));
            if (!raw) {
                setHiddenItemIds(new Set());
                return;
            }
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                setHiddenItemIds(new Set());
                return;
            }
            setHiddenItemIds(new Set(parsed.filter((value) => typeof value === 'string')));
        } catch {
            setHiddenItemIds(new Set());
        }
    }, [props.serverId]);

    useEffect(() => {
        if (props.show) {
            window.desktop.setActivityViewVisible(true);
            searchInputRef.current?.focus();
        } else {
            window.desktop.setActivityViewVisible(false);
        }
    }, [props.show]);

    if (!props.show) {
        return null;
    }

    return (
        <div className={classNames('ActivitySidebar', {darkMode: props.darkMode})}>
            <div className='ActivitySidebar__header'>
                <h2 className='ActivitySidebar__title'>
                    <FormattedMessage
                        id='renderer.components.activitySidebar.title'
                        defaultMessage='Activity'
                    />
                </h2>
                <div className='ActivitySidebar__headerActions'>
                    <button
                        className='ActivitySidebar__iconBtn'
                        onClick={refresh}
                        disabled={!canLoad || loading}
                        title={intl.formatMessage({id: 'renderer.components.activitySidebar.refresh', defaultMessage: 'Refresh'})}
                    >
                        <i className={classNames('icon icon-refresh', {spinning: loading})}/>
                    </button>
                    <button
                        className='ActivitySidebar__iconBtn'
                        onClick={props.onClose}
                        title={intl.formatMessage({id: 'renderer.components.activitySidebar.close', defaultMessage: 'Close'})}
                    >
                        <i className='icon icon-close'/>
                    </button>
                </div>
            </div>

            <div className='ActivitySidebar__search'>
                <div className='ActivitySidebar__searchBox'>
                    <i className='icon icon-magnify ActivitySidebar__searchIcon'/>
                    <input
                        ref={searchInputRef}
                        className='ActivitySidebar__searchInput'
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        placeholder={intl.formatMessage({id: 'renderer.components.activitySidebar.searchPlaceholder', defaultMessage: 'Search activity...'})}
                        disabled={!canLoad}
                    />
                    {query && (
                        <button
                            className='ActivitySidebar__searchClear'
                            onClick={clearSearch}
                        >
                            <i className='icon icon-close-circle'/>
                        </button>
                    )}
                </div>
                {query && (
                    <div className='ActivitySidebar__searchActions'>
                        <button
                            className='ActivitySidebar__searchBtn'
                            onClick={() => search()}
                            disabled={!canLoad || loading}
                        >
                            <FormattedMessage
                                id='renderer.components.activitySidebar.searchLocal'
                                defaultMessage='Search'
                            />
                        </button>
                    </div>
                )}
            </div>

            {lastUpdated && (
                <div className='ActivitySidebar__meta'>
                    <span className='ActivitySidebar__lastUpdated'>
                        <FormattedMessage
                            id='renderer.components.activitySidebar.lastUpdated'
                            defaultMessage='Updated {time}'
                            values={{time: new Date(lastUpdated).toLocaleTimeString()}}
                        />
                    </span>
                    {props.serverName && (
                        <span className='ActivitySidebar__serverName'>
                            {props.serverName}
                        </span>
                    )}
                </div>
            )}

            {error && (
                <div className='ActivitySidebar__error'>
                    {error}
                </div>
            )}

            <div
                className={classNames('ActivitySidebar__feed', {'ActivitySidebar__feed--demoBlur': window.desktop?.activityDemoBlur})}
            >
                {visibleItems.map((item) => (
                    <button
                        key={getUniqueActivityItemId(item)}
                        className='ActivitySidebar__item'
                        onClick={() => openItem(item)}
                    >
                        {item.actorAvatarUrl && !failedAvatarIds.has(item.canonicalId) ? (
                            <img
                                className='ActivitySidebar__itemAvatar'
                                src={item.actorAvatarUrl}
                                alt=''
                                loading='lazy'
                                onError={() => handleAvatarError(item.canonicalId)}
                            />
                        ) : (
                            <div className='ActivitySidebar__itemIcon'>
                                <i className={`icon ${EVENT_KIND_ICONS[item.eventKind] || 'icon-bell-outline'}`}/>
                            </div>
                        )}
                        <div className='ActivitySidebar__itemContent'>
                            <div className='ActivitySidebar__itemHeader'>
                                <span className='ActivitySidebar__itemKind'>
                                    {EVENT_KIND_LABELS[item.eventKind] || item.eventKind}
                                </span>
                                <span className='ActivitySidebar__itemMeta'>
                                    <span className='ActivitySidebar__itemTime'>
                                        {formatRelativeTime(item.eventTs)}
                                    </span>
                                    <span
                                        className='ActivitySidebar__itemHide'
                                        role='button'
                                        tabIndex={0}
                                        title={intl.formatMessage({id: 'renderer.components.activitySidebar.hideItem', defaultMessage: 'Hide'})}
                                        aria-label={intl.formatMessage({id: 'renderer.components.activitySidebar.hideItem', defaultMessage: 'Hide'})}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            hideItem(getUniqueActivityItemId(item));
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                hideItem(getUniqueActivityItemId(item));
                                            }
                                        }}
                                    >
                                        ×
                                    </span>
                                </span>
                            </div>
                            <div className='ActivitySidebar__itemPreview'>
                                {item.previewText || intl.formatMessage({id: 'renderer.components.activitySidebar.noPreview', defaultMessage: '(no preview)'})}
                            </div>
                        </div>
                    </button>
                ))}

                {!visibleItems.length && !loading && (
                    <div className='ActivitySidebar__empty'>
                        <i className='icon icon-bell-off-outline ActivitySidebar__emptyIcon'/>
                        <FormattedMessage
                            id='renderer.components.activitySidebar.noActivity'
                            defaultMessage='No activity yet'
                        />
                    </div>
                )}

                {loading && (
                    <div className='ActivitySidebar__loading'>
                        <div className='ActivitySidebar__spinner'/>
                    </div>
                )}

                {!loading && canLoad && hasMore && (
                    <div className='ActivitySidebar__loadMoreWrap'>
                        <button
                            className='ActivitySidebar__loadMoreBtn'
                            onClick={loadOlder}
                        >
                            <FormattedMessage
                                id='renderer.components.activitySidebar.loadMore'
                                defaultMessage='Load more'
                            />
                        </button>
                    </div>
                )}

            </div>
        </div>
    );
}
