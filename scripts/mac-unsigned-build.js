#!/usr/bin/env node
// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
//
// Workaround for "resource fork, Finder information, or similar detritus not allowed"
// when ad-hoc signing on macOS. Builds app, runs xattr+sign, then packages zip/dmg.

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = process.cwd();
const appOutDir = path.join(projectDir, 'release', 'mac-arm64');
const appPath = path.join(appOutDir, 'Mattermost.app');
const entitlements = path.join(projectDir, 'resources', 'mac', 'entitlements.mac.inherit.plist');

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {stdio: 'inherit', ...opts});
    if (r.status !== 0) {
        process.exit(r.status ?? 1);
    }
}

// Step 1: Build app (will fail at signing, but app is created)
console.log('Building app (signing will fail, app will be created)...');
const build = spawnSync('npx', [
    'electron-builder', '--mac', 'dir', '--arm64', '--publish=never',
    '-c.mac.gatekeeperAssess=false', '-c.mac.hardenedRuntime=false',
    '-c.mac.notarize=false', '-c.mac.identity=-',
], {
    stdio: 'inherit',
    env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'},
});

if (!fs.existsSync(appPath)) {
    console.error('App was not created at', appPath);
    process.exit(1);
}

// Step 2: Clear extended attributes (recursive)
console.log('Clearing extended attributes...');
run('xattr', ['-cr', appPath]);

// Step 3: Ad-hoc sign the app (innermost first, xattr before each to avoid detritus)
console.log('Signing app with ad-hoc identity...');
const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
if (fs.existsSync(frameworksDir)) {
    for (const name of fs.readdirSync(frameworksDir)) {
        const item = path.join(frameworksDir, name);
        if (fs.statSync(item).isDirectory()) {
            run('xattr', ['-cr', item]);
            const macos = path.join(item, 'Contents', 'MacOS');
            if (fs.existsSync(macos)) {
                for (const exe of fs.readdirSync(macos)) {
                    const exePath = path.join(macos, exe);
                    run('xattr', ['-c', exePath]);
                    run('codesign', ['--sign', '-', '--force', '--timestamp', exePath]);
                }
            }
            run('xattr', ['-cr', item]); // clear again after signing inner exe (codesign may add detritus)
            run('codesign', ['--sign', '-', '--force', '--timestamp', item]);
        }
    }
}
run('xattr', ['-cr', appPath]); // clear again after signing frameworks (codesign may add detritus)
run('xattr', ['-c', path.join(appPath, 'Contents', 'MacOS', 'Mattermost')]);
run('codesign', [
    '--sign', '-', '--force', '--timestamp',
    '--entitlements', entitlements,
    path.join(appPath, 'Contents', 'MacOS', 'Mattermost'),
]);
run('xattr', ['-cr', appPath]);
run('codesign', ['--sign', '-', '--force', '--timestamp', '--entitlements', entitlements, appPath]);

// Step 4: Package zip and dmg from prepackaged app
console.log('Creating zip and dmg...');
run('npx', [
    'electron-builder', '--prepackaged', appPath, '--mac', 'zip', 'dmg', '--arm64', '--publish=never',
    '-c.mac.gatekeeperAssess=false', '-c.mac.hardenedRuntime=false',
    '-c.mac.notarize=false', '-c.mac.identity=-',
], {
    env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'},
});

console.log('Done. Artifacts in release/');
