#!/usr/bin/env node
// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
//
// Builds Windows or Linux packages with fork naming: Mattermost.${version}-a

const {spawnSync} = require('child_process');
const path = require('path');

const projectDir = process.cwd();
const pkg = require(path.join(projectDir, 'package.json'));
const version = pkg.version;
const execName = `Mattermost.${version}-a`;

const platform = process.argv[2];
if (!['windows', 'linux'].includes(platform)) {
    console.error('Usage: node package-fork.js <windows|linux>');
    process.exit(1);
}

const eb = (arch) => [
    'electron-builder',
    '--' + (platform === 'windows' ? 'win' : 'linux'),
    platform === 'windows' ? 'zip' : 'tar.gz',
    ...(arch ? ['--' + arch] : []),
    '--publish=never',
    `-c.${platform === 'windows' ? 'win' : 'linux'}.executableName=${execName}`,
];

spawnSync('npm', ['run', 'build-prod'], {stdio: 'inherit', cwd: projectDir});

let r;
if (platform === 'windows') {
    r = spawnSync('npx', eb().concat('--x64', '--arm64'), {stdio: 'inherit', cwd: projectDir});
} else {
    r = spawnSync('npx', eb('x64'), {stdio: 'inherit', cwd: projectDir});
    if (r.status === 0) {
        r = spawnSync('npx', eb('arm64'), {
            stdio: 'inherit',
            cwd: projectDir,
            env: {...process.env, CC: 'aarch64-linux-gnu-gcc', CXX: 'aarch64-linux-gnu-g++'},
        });
    }
}
process.exit(r.status ?? 0);
