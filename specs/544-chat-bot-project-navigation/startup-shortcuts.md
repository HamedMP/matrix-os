# Chat startup and context shortcuts (ENG-177)

Status: implementation underway; exact-head native review pending. Follow-up to merged ENG-166 / #2241.

## Ordinary history publication

Classify newly unknown Chat identities as a bounded cohort, then publish ordinary rows together before waiting for Bot approval attention. Keep same-client verified history and Bot reminders visible during background refresh and remount. Failed/unknown bindings remain excluded; stale client/cohort completions cannot publish. Newly ordinary raw-cache results do not hydrate until a live classification cohort commits; cache sizes, TTLs and four-read concurrency remain bounded. This supersedes the previous expectation that fast ordinary identities publish while slower identities in the same cold cohort are pending.

Atomic presentation does not imply faster completion of uncached per-ID identity queries. The original cohort repair adds no batch backend API or cross-reload identity persistence. The approved follow-up in [navigation-loading-cache.md](navigation-loading-cache.md) adds bounded batch navigation reads and disposable metadata snapshots; shared Web consumers retain the same classification safety.

## New Chat presentation

Cmd+N (Ctrl+N on other platforms) from a visible Chat creates a separate draft in its current surface presentation: floating to floating, tab to tab. Preserve original surface bounds, history and unsent draft; focus the new draft and never create/send an empty persisted Chat. Hidden/minimized/background surfaces cannot capture the shortcut. Cmd+T deliberately creates top-level tabs and retains its existing Files/Terminal behavior.

## Project details

The user clarified Hamed's report as an excessive vertical gap between Project details/cards and the Chat input area. Let long detail/card lists use the available height above the composer instead of an arbitrary percentage cap and empty expanding sibling region. Preserve current card/content widths, floating/tab mode, provider onboarding, Project context, input visibility and draft state in short/narrow windows. Metadata visibility on actual draft/conversation routes stays unchanged.

## Verification and delivery

Regressions require RED/GREEN hook, rendered WorkRail, shortcut/surface and actual Chromium layout tests, then uniquely named exact-head production Electron Desktop acceptance connected to the reviewed Main computer. Verify cold batch transitions, warm history/Bot stability, floating and tab Cmd+N, Cmd+T, retained unsent drafts and Project detail/composer bounds. Public documentation ships in a separate FinnaAI/matrix-os-site PR. Human Review precedes fresh authorized Greptile 5/5 and exact-head CI. Preserve all Figma geometry and PINNED above PROJECTS.
