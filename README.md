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

**Manual run (test without tag):** Actions -> release-fork -> Run workflow -> enter tag (e.g. `5.10.2-activity-test`) -> Run. Builds from current branch, creates release with that tag.

**Release on tag push:** `git tag 5.10.2-activity && git push origin 5.10.2-activity` - workflow runs automatically and creates a release.[^2]

[^2]: Release notes are in `.github/workflows/release-fork.yml` (Create release notes step). Edit the heredoc there to change the text for future releases.

### Unsigned builds

- **macOS:** First launch: Right-click -> Open (Gatekeeper blocks unsigned apps by default).
- **Windows:** SmartScreen may warn - "More info" -> "Run anyway".
- **Linux:** No restrictions.
