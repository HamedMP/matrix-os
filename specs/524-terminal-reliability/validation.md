# Execution evidence — 2026-09-17

## First repair candidate

PR #1736, commit `d4f20f8f6817fed902c684ea4abe9d7bac7daa50`. Account-owned Preview `pr-1736` runs `v2026.09.17-pr1736-35234533010-1-d4f20f8`; installed/running version and release SHA match. The shared-default-owner workflow was cancelled after deployment, and only its newly created disposable VPS was replaced through the supported platform API so the reviewer retains owner-only Terminal access. No production promotion or global auth change occurred.

- 13 new unit/Unix socket regressions pass; repo and runtime type checks, pattern scan, Electron production build pass.
- Full macOS suite: 15,726 pass, 30 fail, 44 skipped. All 30 failing test names reproduce on untouched de815be50. This is not a green full suite.
- Actual baseline Electron startup emitted 259 protocol replies. Baseline live probes closed at 33 and 259 individual frames; the fixed Preview stays open at 32, 33, 259, 33 and 259, answers ping, and executes subsequent commands.
- Fixed Electron startup emitted 259 replies with no WebSocket close/error over 24 seconds.
- Live observer/writer/revoked-writer/takeover cases pass. Normal and zero-delay keyboard tracing delivers the complete input and expected result on an attached terminal.
- Final 10 consecutive fresh-terminal trials, waiting for actual attached state before interaction, each opened one new connection, obtained writer authority, and produced its unique result exactly once, with no connection-status warning. Intentional closure of the previous tab's viewer is excluded from reconnect counts.
- Gateway and runtime service checks during validation reported zero restarts and no relevant overflow/attach failure logs.

## Remaining evidence gaps

An earlier repeated-opening pass observed one socket close/reopen before the first attached frame, after which input succeeded. Its cause is not established; final trials did not reproduce it. Retain this as an open lifecycle observation, distinct from the verified input-burst overflow. Earlier fixed-delay automation also attempted input before readiness and interacted unreliably with xterm's helper textarea; those interrupted trials are not counted as passing.

The complete matrix in quickstart.md remains pending beyond the bounded checks above. Web/Canvas/mobile parity, long-duration reconnects, old processes across two upgrades, replay/snapshot restoration and all everyday interactions have not been established by this repair. Human Review and exact-head landing gates remain open. This document is evidence for a candidate, not a declaration of complete Terminal reliability.

## Separate confirmed baseline defect

Tab rename returned HTTP 500 while preparing review labels. Socket dispatch passes the entire RenameTab input to strict TerminalRefSchema, including name/baseRevision; the same code exists on the untouched baseline. Tracked independently in [#1738](https://github.com/HamedMP/matrix-os/issues/1738). The review environment retains two original tab names. This was separate from the startup queue cause and is now repaired in the follow-up recorded below.

## Human Review follow-up — startup snapshot row alignment

The reviewer observed text moving down and returning on new/opened terminals. Electron tracing showed stable host geometry, a snapshot with an extra initial row, and a subsequent native redraw at row zero. The Zellij 0.44.3 ANSI dump implementation serializes empty history as an SGR reset and then adds a separator; the CLI adds a final newline. Short viewports also need to be positioned after their history, rather than replayed as an undifferentiated text stream.

PR #1736 commits `0e7e5621a` and `eec0fca19` decode the known CLI framing and restore unused viewport rows while retaining ambiguous blank history above the current screen. No whitespace trimming, connection-banner delay, or hidden initial text is used. Imported snapshots without viewport metadata keep existing behavior. Seven new failing-first regressions cover the row defect; a compatibility guard covers full and legacy viewports, and the socket test renders the actual emitted snapshot through xterm. Final candidate `15e004475` additionally preserves the public frame limit when alignment bytes would exceed it. Runtime suite: 186 passed, 5 opt-in skips. Runtime TypeScript and Electron build passed. Exact-head live Preview results are recorded below.

The visual trace also captured an independent native attach failure: runtime `attachNow` observed the native client exit while its attachment was opening, reporting `Terminal tab unavailable`; the gateway exposed `runtime_unavailable` and reconnected. This is concrete evidence for the previously unexplained pre-attachment reconnect. Its underlying native-client exit cause remains unknown and is not fixed by snapshot alignment.

Exact-head follow-up validation: Preview installed/running versions now match `v2026.09.17-pr1736-35246629483-1-15e0044`, release SHA `15e0044758f0703cedea7c981673d4d98041f69b`. All 9 existing tabs survived the scoped update. Old Preview: 3/3 fresh-terminal trials showed row 1 -> row 0. New Preview: 3/3 fresh-terminal and 3/3 reopen trials kept the prompt at row 0, each with one connection and no error frame/status warning. Actual keyboard input produced 80 numbered lines; after reopening all 80 unique lines remained in order and the bottom prompt was visible. Buffer comparison trims native redraw padding, not terminal data. Four runtime services are active; the final observation window had no matching attach/overflow errors. Human Review remains pending.

Preview workflow `35246629483` built and registered the exact bundle without channel promotion, then failed provisioning with HTTP 500. Cloud Run startup probe failures were present in that interval; the workflow failure cause is not conclusively established. The existing reviewer-owned Preview was updated through the supported scoped deployment API and independently verified. No Preview replacement, customer VPS mutation or production promotion occurred during this follow-up.

## Human Review follow-up — scrolling and unused grid space

The reviewer accepted the startup row repair, then reported trackpad edge failure, a floating gray second scrollbar, and blank scrolling around short content. The reviewer explicitly selected one vertical scrollbar for history plus clipped live rows.

PR #1736 commits `34b712981` and `f1cb75b38` consume clipped-grid wheel motion before forwarding the remainder, preserve manual position through redraws, unify the native rail, and measure normal-screen content extents without changing the canonical server grid. Alternate screens, background-painted cells, wide glyphs and cursor cells are retained. A failing-first rail race test also covers delayed host-scroll events overwriting a pending drag.

Focused checks: 98 pass across six suites. Four real-browser renderer scenarios pass (Web Desktop, Web Canvas at 0.75 zoom, Electron Desktop renderer, Web Mobile), plus a native Electron scenario. One earlier browser run passed all four cases but timed out during teardown; the completed rerun is recorded separately. Real Preview-connected Electron confirmed zero overflow for a three-line terminal, one visible history rail, history row zero at its top, and the complete live-grid bottom at its bottom. Final exact-head Preview rollout and physical trackpad Human Review remain pending. This does not close the independent native-attach finding or the complete reliability matrix.

## Follow-up — blank-area wheel input and deletion acknowledgment

Candidate `b1d5df4c6` fixes a wheel dead zone: after short-content clipping, gestures outside the xterm element reached the host but were excluded from forwarding. The entire viewport now forwards the remaining gesture at a valid canonical-grid coordinate. Real Preview-connected Electron emitted native Zellij wheel reports from that area and reached numbered line 1 and line 80 plus the prompt in both directions. This preserves terminal mouse reporting rather than replacing it with a local-only scroll.

Deletion previously removed a row optimistically while shutdown was pending, allowing a concurrent backend list to restore it. Both Electron and Web now wait for deletion acknowledgment and invalidate pre-acknowledgment list responses. Tests cover pending deletion, failures, stale list completion, and changing computers while deletion is pending. The Web implementation extracts its network operation rather than expanding the large sidebar composition file.

147 focused tests pass; four browser renderer cases and one native Electron fixture pass. Desktop and Web TypeScript, exact-head Electron production build, and the pattern scan pass (zero violations, five pre-existing warnings). Exact-head Preview deployment and latest Human Review remain pending.

Latest candidate `bf9b6d506` explicitly labels pending deletion as `Deleting…` and focuses xterm when the user clicks unused viewport space. Two new failing-first tests reproduced missing label/focus behavior. 88 related tests, four browser renderer cases, and one native Electron case pass; existing selection assertions remain green. Desktop and Web type checks pass. Preview publication is being refreshed for this head.


## Follow-up — strict control references and native history evidence

Candidate `11dda0084` separates rename payload fields from the strict terminal reference at the socket boundary. The exact Preview bundle was verified installed/running, live rename succeeded and persisted on readback, and gateway/shell/sync/runtime health passed. A transient revision conflict immediately after tab creation was respected; verification waited for activation and read the current revision before renaming.

The reviewer then reported Pin failure. Candidate `7ebaabe32` fixes the same mixed-reference defect in UpdateTabUiState, WriteInput, and Resize. Four new tests fail on the old dispatcher. The repaired boundary passes 65 runtime/socket/store tests plus 23 Desktop store/sidebar tests. Pin/unpin tests use the actual durable store over a Unix socket, instantiate a new store to verify persistence, and reject stale revisions. Runtime TypeScript, pattern scan (zero violations), and Electron production build pass. Exact-head Preview live Pin verification remains pending publication.

The reviewer also reproduced incorrect scrollbar position and thumb length. This invalidates any interpretation of earlier local-rail fixtures as proving native-history synchronization. Zellij processes native mouse-wheel reports and redraws its viewport without updating xterm's local history offset. Therefore the existing rail can disagree with the actual history being displayed. Track this unresolved defect in [#1745](https://github.com/HamedMP/matrix-os/issues/1745).

An isolated Zellij 0.44.3 plugin experiment read native pane contents above and below the viewport: the synthetic fixture reported 70 above / 0 below at bottom, 0 above / 70 below at top, then 70 above / 0 below again. Each query took roughly 78 ms. The CLI subscriber only includes above-viewport history on its initial event, and full screen dumps omit below-viewport history; neither alone supplies an authoritative scrolling range. The plugin required an attached native client and explicit pane-read/CLI-pipe permissions. This is feasibility evidence only, not production implementation or an approved permission/deployment design.

A follow-up implementation must use authoritative native position/range for wheel and dragging, retain full-screen application mouse input and observer/writer rules, handle wrapping/blank rows/resize, bound requests and cleanup, and preserve existing sessions across upgrade. Do not infer position from wheel counts or claim a constant/local-only thumb fixes this defect. Human Review of these remaining changes is open.


Exact-head control verification: bundle `v2026.09.17-pr1736-35261008382-1-7ebaabe` is installed and running at `7ebaabe324caf587470d09671ec399656a5a9445`. The old Preview reproduced Pin HTTP 500; the repaired Preview passes Pin, Unpin, fresh-list readback, and Rename. The temporary verification tab was deleted afterward. All four services are active. Eight existing sessions remain; the reviewer confirmed manually deleting the ninth, so it is not attributed to deployment. The matching Electron production build is open on the owner Preview for Human Review. The native scrollbar issue remains unresolved.
