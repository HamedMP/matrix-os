# Local canary console repairs

Existing tickets: [ENG-35](https://linear.app/matrix-os/issue/ENG-35/cut-clients-over-to-direct-owner-home-collaboration-authority)
for direct resource discovery; [GTM-40](https://linear.app/matrix-os/issue/GTM-40/warm-the-desktop-app-catalog-and-icons-before-apps-opens)
for bounded icon warmup. Support remains [ENG-356](https://linear.app/matrix-os/issue/ENG-356/fix-posthog-support-message-sending-in-electron-desktop).

## Observed faults and local changes

- Accepted shared folders were hydrated through the Chat adapter. The live folder scope and
  drive endpoints returned 200 while the unnecessary `/chat` endpoint returned 503 repeatedly.
  Discovery now leaves standalone folder, file and app metadata for their authorized readers.
  Existing Chat, Terminal and Project hydration stays covered by the direct-client suite.
- App icon warmup declared offscreen catalog icons as immediately needed image preloads.
  The live console showed hundreds of repeated warnings naming those icon URLs. Use low
  priority prefetch hints while retaining the 20-icon cap and runtime/sign-out cleanup.
- Before these repairs, all three standalone-resource regressions and the icon hint regression
  failed. The focused discovery/client/drive/icon suites pass all 37 checks afterward.

## Live local validation, 31 October 2026

Rebuilt Electron Desktop from the task worktree with the canary channel and an isolated
temporary profile. The installed release and its profile were preserved. During the new
authenticated session, the folder `/chat` 503s and unused-icon preload warnings no longer
appeared. The Company drive remained visible. This is local evidence, not deployed-preview
qualification or permission to promote a release.

Remaining failures are explicit:

- The production support identity endpoint still signs with the unnormalized key. The local
  platform repair must reach a reviewed test runtime before send/reply acceptance testing.
- A separate shared project's owner home rejects direct-session exchange with 401, producing
  a share-unavailable warning. Platform ticket issuance succeeds. Its owner-home diagnosis
  has been handed off separately at the requester's direction and is outside this support
  repair's release scope. No authorization or log filtering was changed to hide that failure.
- Earlier captures showed blocked third-party tracking scripts in an embedded remote page.
  They did not recur in this new session. CSP must remain scoped; investigate the page's
  script inclusion if they recur rather than allowlisting tracking origins to clear errors.

All 170 checks in 13 affected suites pass, including the complete device/auth route suite.
Desktop typechecking and the local production Electron build pass. Production services,
secrets, settings and release channels remain unchanged. Recommend Desktop and collaboration
owner review; collect current-build screenshots and recordings for each affected surface
before review readiness. Shared discovery affects Web Canvas, Web Desktop, Web Mobile and
Electron Desktop consumers; those other surfaces remain unqualified here.

## Invariants

- Authority: the owner home still authorizes each resource read; platform discovery is metadata.
- Atomicity: no database writes, new endpoints, locks or transactions are added.
- Failure: direct-session errors retain their safe unavailable/denied behavior.
- Resources: icon warmup remains capped and explicitly removed on identity/runtime changes.
- Release: real support submission/reply, current-head review and CI remain open. The separate
  owner-home collaboration diagnosis is a distinct handoff rather than this task's blocker.

Public-site documentation: no new product capability or user instructions; these restore
existing behavior. A documentation PR is unnecessary unless review identifies changed guidance.
