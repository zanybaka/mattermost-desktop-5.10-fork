# Mattermost Desktop (fork)

Fork adds **Activity** - a sidebar panel aggregating mentions, threads, reactions, DMs, GMs and reminders in a single feed.[^1]

[^1]: Original readme: [release-5.10 README](https://github.com/mattermost/desktop/blob/release-5.10/README.md). Copy: [README.Original.md](README.Original.md).

## Activity (with demo blur)

![Activity panel - All items](example-all.png)
![Activity panel - Reminders](example-reminders.png)
![Activity panel - Important threads](example-important-threads.png)

**Video:** [Mattermost - My Activity](https://github.com/zanybaka/mattermost-desktop-5.10-fork/releases/download/5.10.2-activity/Mattermost.-.My.Activity.mp4)

**Summary:** Activity is a sidebar panel that aggregates mentions, thread replies, reactions, DMs, GMs and reminders into a single chronological feed. It is opened from the Mattermost webapp sidebar (injected item). Native Threads and Mentions sidebar items can be hidden to avoid duplication.

**Details:**

* **Sources:** Data is fetched from Mattermost API via adapters: mentions (recent_mentions, unread), threads (teams/threads), reactions (post metadata), DMs/GMs (direct channels), reminders (users/me/reminders). Sources can be toggled per kind via env vars (`MM_DESKTOP_ACTIVITY_SOURCE_*`).

* **UI:** Activity item in the webapp sidebar opens an overlay panel. The panel shows a feed with Load more, Refresh, and local search. Items can be filtered by Threads/Mentions. Individual items can be hidden (x). Clicking an item navigates to the post/thread/channel.

* **Demo blur:** Set `MM_DESKTOP_ACTIVITY_DEMO_BLUR=1` to enable a blur overlay on the sidebar and main content (for demo purposes).

* **Implementation:** `externalAPI.ts` injects the Activity item into the webapp sidebar; `ActivitySidebar.tsx` renders the React overlay; `activityAggregationService` merges and deduplicates items; IPC handlers in `activityIntercom.ts` bridge main and renderer.

## Build

### Local build

```bash
npm ci
# macOS (arm64 only, unsigned):
npm run package:mac-unsigned
# Windows:
npm run package:windows-zip
# Linux:
npm run package:linux-tar
```

Artifacts go to `release/5.10.2/`.

### GitHub Actions (release-fork)

Fork releases keep `package.json` version at `5.10.2`. The public release number is the **git tag** in the form `5.10.2-activity-releaseN` (examples: `…-release6`, then `…-release7`). Check the latest tag with `git tag -l '5.10.2-activity-release*' --sort=-v:refname | head -1` and bump `N` by one. Workflow `release-fork` is **manual only** (`workflow_dispatch`); tag push does not start a build.

**Ship a release (same flow as before):**

```bash
# 1. Merge the feature/fix branch into the fork release branch
git checkout release-5.10-fork
git pull origin release-5.10-fork
git merge <feature-or-fix-branch>
# resolve conflicts if any, then:
git push origin release-5.10-fork

# 2. Tag the tip of release-5.10-fork (do not bump package.json)
#    Replace N with the next free number after the latest 5.10.2-activity-release* tag
git tag 5.10.2-activity-releaseN
git push origin 5.10.2-activity-releaseN

# 3. Build in GitHub Actions
# Actions → release-fork → Run workflow
#   Branch: release-5.10-fork
#   Tag:    5.10.2-activity-releaseN
```

After the workflow finishes, GitHub Releases will have that tag with macOS / Windows / Linux artifacts.

**Dry-run / test tag:** Actions → release-fork → Run workflow → enter any tag (e.g. `5.10.2-activity-test`) on the branch you want to build. Same workflow, no need to change `package.json`.

Release notes text lives in `.github/workflows/release-fork.yml` (Create release notes step). Edit that heredoc for future releases.

### Unsigned builds

- **macOS:** First launch: Right-click -> Open (Gatekeeper blocks unsigned apps by default).
  - If "damaged": Right-click app -> Open, or run: `xattr -cr /path/to/Mattermost.app`
  - If "Not Opened: Apple could not verify ... is free of malware": System Settings -> Privacy & Security -> Open Anyway
- **Windows:** SmartScreen may warn - "More info" -> "Run anyway".
- **Linux:** No restrictions.
