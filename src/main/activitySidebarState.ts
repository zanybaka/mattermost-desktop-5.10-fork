// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {BrowserWindow} from 'electron';

import {BACK_BAR_HEIGHT, TAB_BAR_HEIGHT} from 'common/utils/constants';

let sidebarOpen = false;

export function setActivitySidebarOpen(isOpen: boolean) {
    sidebarOpen = isOpen;
}

export function isActivitySidebarOpen() {
    return sidebarOpen;
}

export function getActivityViewWidth(totalWidth: number) {
    return totalWidth;
}

export function getActivityViewBounds(win: BrowserWindow, hasBackBar = false) {
    const {width, height} = win.getContentBounds();
    const viewY = TAB_BAR_HEIGHT + (hasBackBar ? BACK_BAR_HEIGHT : 0);
    const viewHeight = height - TAB_BAR_HEIGHT - (hasBackBar ? BACK_BAR_HEIGHT : 0);

    return {
        x: 0,
        y: viewY,
        width,
        height: viewHeight,
    };
}
