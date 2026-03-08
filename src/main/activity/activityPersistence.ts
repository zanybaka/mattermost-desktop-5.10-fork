// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {mkdir, readFile, readdir, rm, stat, writeFile} from 'fs/promises';
import path from 'path';

import {app} from 'electron';

import {deserializePersistedActivityState, serializePersistedActivityState} from 'common/activity/persistence';
import type {PersistedActivityState} from 'common/activity/types';
import {Logger} from 'common/log';

const log = new Logger('ActivityPersistence');

class ActivityPersistence {
    private getActivityDirPath() {
        return path.join(app.getPath('userData'), 'activity');
    }

    private getSnapshotsDirPath() {
        return path.join(this.getActivityDirPath(), 'snapshots');
    }

    private getFilePath(serverId: string) {
        return path.join(this.getActivityDirPath(), `${serverId}.json`);
    }

    load = async (serverId: string): Promise<PersistedActivityState | null> => {
        try {
            const raw = await readFile(this.getFilePath(serverId), 'utf8');
            return deserializePersistedActivityState(raw);
        } catch (error) {
            log.silly('load failed', serverId, error);
            return null;
        }
    };

    save = async (state: PersistedActivityState): Promise<void> => {
        try {
            const filePath = this.getFilePath(state.serverId);
            await mkdir(path.dirname(filePath), {recursive: true});
            await writeFile(filePath, serializePersistedActivityState(state), 'utf8');
        } catch (error) {
            log.warn('save failed', state.serverId, error);
        }
    };

    getCacheStats = async (serverId?: string): Promise<{
        rootPath: string;
        stateBytes: number;
        snapshotBytes: number;
        totalBytes: number;
        stateFiles: number;
        snapshotFiles: number;
    }> => {
        const rootPath = this.getActivityDirPath();
        const snapshotsPath = this.getSnapshotsDirPath();

        let stateBytes = 0;
        let stateFiles = 0;
        try {
            if (serverId) {
                const stats = await stat(this.getFilePath(serverId));
                stateBytes = stats.size;
                stateFiles = 1;
            } else {
                const entries = await readdir(rootPath, {withFileTypes: true});
                const stateEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
                stateFiles = stateEntries.length;
                const sizes = await Promise.all(stateEntries.map(async (entry) => {
                    const entryStats = await stat(path.join(rootPath, entry.name));
                    return entryStats.size;
                }));
                stateBytes = sizes.reduce((sum, value) => sum + value, 0);
            }
        } catch {
            // No persisted state yet.
        }

        let snapshotBytes = 0;
        let snapshotFiles = 0;
        try {
            const entries = await readdir(snapshotsPath, {withFileTypes: true});
            const snapshotEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
            snapshotFiles = snapshotEntries.length;
            const sizes = await Promise.all(snapshotEntries.map(async (entry) => {
                const entryStats = await stat(path.join(snapshotsPath, entry.name));
                return entryStats.size;
            }));
            snapshotBytes = sizes.reduce((sum, value) => sum + value, 0);
        } catch {
            // No snapshots yet.
        }

        return {
            rootPath,
            stateBytes,
            snapshotBytes,
            totalBytes: stateBytes + snapshotBytes,
            stateFiles,
            snapshotFiles,
        };
    };

    clear = async (serverId?: string): Promise<void> => {
        if (serverId) {
            try {
                await rm(this.getFilePath(serverId), {force: true});
            } catch {
                // Ignore missing file.
            }
            return;
        }

        try {
            await rm(this.getActivityDirPath(), {recursive: true, force: true});
        } catch {
            // Ignore missing directory.
        }
    };
}

const activityPersistence = new ActivityPersistence();
export default activityPersistence;
