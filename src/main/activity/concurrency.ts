// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export async function forEachWithConcurrency<T>(
    items: T[],
    concurrency: number,
    callback: (item: T) => Promise<void>,
) {
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
            return;
        }

        await callback(items[currentIndex]);
        await runNext();
    };

    await Promise.all(Array.from(
        {length: Math.min(concurrency, items.length)},
        () => runNext(),
    ));
}
