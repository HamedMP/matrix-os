# Implementation and Internal Acceptance Guide

This guide covers implementation and internal acceptance for the six-PR delivery plan. PR1/M1 is implemented in the Graphite review stack #1571–#1578, topped by `codex/collaboration-chat-validation`; the review layers remain one PR1 product milestone and exist only to satisfy repository size limits. PR2's isolated execution foundation is merged and dormant. PR3/M2 is published as review stack #1601–#1603, but has not been enabled for a cohort or validated on a production-equivalent VPS. Later milestones remain unimplemented and disabled.

## PR1 local evidence — 2026-09-07

PR1 adds the common owner-local authority, actor-preserving platform ingress, standalone Chat binding, attributed human discussion, member-private state, scoped realtime recovery, lifecycle/export, and common Web/Electron/native/CLI clients. Existing frozen snapshots remain a separate owner-only feature. M1 execution is denied server-side for every collaboration role.

Current public-safe component evidence:

- [Shared Chat discussion](evidence/m1-shared-chat.png)
- [Snapshot versus live Share chooser](evidence/m1-share-chooser.png)

The screenshots were captured from a temporary self-hosted Next.js route rendering the production `@matrix-os/ui` components at 1440×900. The Playwright check asserted the shared heading and attributed discussion, both Share actions, no framework error overlay, and no browser console errors; the temporary route/test were removed after capture. This is current UI evidence, not a substitute for the still-pending full Web Canvas, Web Desktop, Electron, Web Mobile, and native two-account journey.

Validation results:

| Check | Result |
| --- | --- |
| `pnpm exec vitest run collaboration chat-sharing` | 28 files and 148 tests passed; three real-Postgres files (12 tests) skipped because `MATRIX_TEST_POSTGRES_URL` is unset. The opt-in suites cover scope/capacity/expiry/idempotency, revoke/write serialization, discussion-event atomic rollback, and membership races. |
| Real PostgreSQL transactions | 3 files and 12 tests passed against a disposable loopback-only PostgreSQL 16.13 database. The container and isolated test schemas were removed after the run. |
| Two-account fixture validation | `pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/fixtures/collaboration-fixture.e2e.test.ts` passed 2/2 tests. The fixture uses separate authenticated browser contexts and only session or `/vm/<handle>` runtime routes. |
| Native mobile collaboration Jest | 2 suites and 7 tests passed. |
| Root typecheck command | `bun run typecheck` could not be invoked because `bun` is absent. Its pnpm-equivalent kernel prerequisite and observability, integrations-mcp, gateway, platform, proxy, edge-router, and desktop TypeScript checks all passed; additional contracts, UI, and shell checks passed. |
| Native mobile TypeScript | The project-wide check still fails in unchanged React Native dependency typings (`Image`, `Swipeable`, `WebView`, gesture/PostHog view props, and theme preference); it reports no error in the PR1 collaboration files. |
| `pnpm run check:patterns` | 0 violations; 5 warning groups in unchanged code. |
| `pnpm run test` | 1,161 files / 13,619 tests passed; 44 files / 169 tests failed; 5 files / 23 tests skipped; 21 worker errors. Failures are outside the collaboration suite and include sandbox-denied listen/spawn/git operations and long-running app-build fixtures. |
| React Doctor, changed scope | `packages/ui`, `shell`, and `apps/mobile` have no findings. Desktop has two inherited complexity warnings in `AccountMenu.tsx` and `TabContent.tsx`; the PR1 diff in those files is one menu row and one switch case. |
| Local Playwright UI check | 1/1 passed after it exposed and drove a fix for transparent cross-shell collaboration dialogs. |

Still required before M1 is review-ready or internally enabled: full named-surface screenshots/recordings, a disposable VPS-native two-account/no-computer-recipient journey, snapshot rollback regressions on the release artifact, and the rollout/rollback drill. No runtime acceptance or production enablement is claimed here.

## PR3 M2 local evidence — 2026-09-10

PR3 adds actor-attributed AI requests to the canonical Chat queue, a 32-pending/one-active invariant, actor-scoped idempotency, owner approval decisions, editor-own cancel/retry, dispatch-time reauthorization, truthful interrupted/unavailable recovery, exact-profile isolated execution, and shared queue controls across the common Web/Electron UI, native mobile, and CLI. M1 discussion remains available when M2 policy is off or read-only.

Current public-safe component evidence:

- [Shared AI queue and owner controls](evidence/m2-shared-ai-queue.png)

The screenshot was captured at 1440×900 from a temporary self-hosted Next.js route rendering the production `SharedChatControls` component in a Canvas-style Chat. A focused Playwright check asserted the ordered attributed requests, one-active/32-pending copy, owner approval controls, private Ask AI draft, and zero browser/page errors; the temporary route and test were removed after capture.

Validation results:

| Check | Result |
| --- | --- |
| Real PostgreSQL 16 queue/control run | `MATRIX_TEST_POSTGRES_URL=… pnpm exec vitest run tests/gateway/collaboration-chat-queue.test.ts tests/gateway/collaboration-chat-controls.test.ts` passed 2 files / 15 tests. Four opt-in real-server races cover simultaneous immutable ordering, the 32-pending ceiling under 33 concurrent admissions, actor-scoped idempotency, and exactly one competing owner approval call. The disposable database container was removed afterward. |
| Common Web/Electron UI | 3 files / 19 tests passed for private discussion/AI drafts, queue recovery, viewer restrictions, author controls, approvals, and the two composer modes. |
| Native mobile | 3 files / 20 tests passed for request transport, virtualized ordered queue, role controls, private drafts, and recovery. |
| CLI | 7 tests passed for collaboration request listing, Ask AI, cancel, retry, and approval commands without owner credential fallback. |
| Package TypeScript | Contracts, gateway, UI, and sync-client checks passed. Native mobile still reports only the unchanged React Native dependency typing failures already recorded under PR1. |
| React Doctor, changed scope | `packages/ui` scored 100/100 with no findings; `apps/mobile` scored 97/100 with no findings. |
| Local browser evidence | 1/1 focused Playwright assertion passed and produced the linked screenshot. |
| Exact release acceptance harness | The labeled disposable-preview workflow pins `scope-runtime-chat-v1`, its source-controlled digest and harness version, executes a real `runtime.chat` Agent SDK round trip through a bounded fake inference broker, and restores the dormant systemd/marker state. Two disposable preview attempts accepted the requested deployment but remained on the bootstrap bundle instead of installing the exact PR artifact, so the harness correctly did not claim a pass. This remains a preview updater/platform blocker rather than M2 acceptance evidence. |

Still required before M2 is internally enabled: repair the disposable preview's exact-version install path, rerun the exact-head VPS workflow and record its profile generation/artifact, exercise the complete two-account AI journey on the named production surfaces, and perform the M2-off/read-only rollback drill while confirming M1 discussion remains available. No release-artifact pass or production enablement is claimed here.

## Prepare a slice

1. Re-read the constitution and applicable `AGENTS.md`. Start a manual worktree from current origin/main after dependencies merge; use the repository's stacked workflow only when actually needed.
2. Choose one of PR1–PR6 and its acceptance evidence. Read [spec](spec.md), [plan](plan.md), [data model](data-model.md) and both [HTTP](contracts/collaboration-api.md) and [realtime/execution](contracts/realtime-execution.md) contracts. A merged backend slice must remain dormant until its milestone gate passes.
3. Use Node.js 24+, pnpm and bun through the supported development setup. Install from the repository root using `pnpm install --frozen-lockfile`. Use owner-local and platform Postgres fixtures, not an embedded substitute.
4. Write failing behavior/contract/race tests before runtime changes. Prefer existing canonical Chat and terminal fixtures; extract focused seams rather than append behavior to large composition files.
5. Run focused tests, then required repository checks. Capture failures precisely; a prerequisite build failure means the downstream test suite did not run.

```bash
bun run typecheck
bun run check:patterns
bun run test
```

Use `bun run test:integration` only with the normal supported credentials and bounded low-cost fixture; real execution isolation also needs its explicit VPS-native spike. For surface changes run the relevant Web/Electron/native test harnesses and release-parity build. Record the actual commands with the PR evidence; do not invent test script names for proposed fixtures.

## Common acceptance setup

Use distinct test identities: owner, editor, viewer, outsider; add pending/expired/revoked and over-capacity fixtures. Include an invitee without their own provisioned computer. Use a disposable VPS-native test environment and the exact host/platform/client versions under review. Local Docker fixtures do not establish customer runtime compatibility. Keep identity/host details in private evidence, with public-safe results in the PR.

Start capability modes off. Verify disabled routes reject requests server-side even if a client forces the UI. Enable only the completed milestone for the internal cohort through existing platform operator configuration. Keep roles and access restrictions identical to the eventual feature. Later milestones stay off until their gates pass. PR2 and PR5 merge as disabled foundations; PR3 completes M2 and PR6 completes M4. Prove isolation before building its adapter within PR2; backend migration tests belong in PR5 before final UI/integration in PR6.

For every milestone verify invite → matching-account accept → open → role-permitted action → downgrade → revoke → reconnect denial, including direct HTTP/WS, CLI where applicable, and owner legacy-route bypass. New admission fails after authoritative revoke; affected live connections close within 60 seconds. Test concurrent grants/actions using real Postgres and delayed packets, not only sequential UI clicks.

## Milestone journeys

| Gate | Demonstration and negative evidence |
| --- | --- |
| M1, PR1 | Share an idle existing Chat; both users see the same history and attributed discussion. Viewer reads only. Drafts, composing mode and read/pin/mute state remain individual. Discussion starts zero AI runs. Shared execution is denied through owner legacy and direct routes. Existing active/pending personal work blocks conversion until settled. Reconnect recovers history without duplicate messages or private references. |
| M2, PR2 + PR3 | Record real isolation proof for at least one supported adapter. Both users explicitly request AI work while idle and busy; queue stays ordered, one run active, 32 pending maximum. Owner approval wins exactly once; editor controls only own eligible requests. Revoked queued authors never start. Fail/restart during dispatch and external completion uncertainty without silently repeating a side effect. Private resume state/files/credentials remain inaccessible. |
| M3, PR4 | Share an eligible running terminal and verify unchanged session/incarnation/process. Both see bounded output. Editor waits for release/expiry; owner may take control. Deliver delayed input/paste/resize after transfer or revoke and verify rejection. Viewer cannot input or create terminals. Reconnect/restart does not replay input. Existing unrestricted sessions fail preflight intact. |
| M4, PR5 + PR6 | Use a mixed project with files, Chat, app/data, layout and eligible running terminal. Confirm one complete inventory without exclusions. All owned contents move to one declared authority; new resources inherit. Earlier item-only members are not silently promoted. Change inventory before commit and require reconfirmation. Inject crashes at every journal step; no partial participant access or two writable authorities. An incompatible owned resource blocks the complete transition. |

For PR1, verify the existing Share entrypoint exposes **Share snapshot** and **Invite collaborators**. Re-run #1551 snapshot regressions: owner preview/confirmation, stale consent refresh, frozen content, seven-day expiry, revoke, excluded attachment/tool/hidden content and inert private file links. An anonymous snapshot reader cannot open live history, accept membership or attach streams; a collaborator cannot manage public snapshots merely by being an editor/viewer. Link revocation and membership revocation affect their respective targets, and disabling live collaboration preserves snapshots. Reuse attachment/navigation components only with scope-authorized destinations. Existing focused fixtures are listed in [research](research.md); merged snapshot UI is not proof of collaboration surface parity.

For project files test symlink/traversal/moved-root/legacy write paths, export scope and viewer indirect writes through tools/apps/Git. For each scope test archive, transfer, export, delete and owner recovery without exposing unrelated data. Terminal stop obeys creator authority; closing an observer tab does not stop the process.

## Surface evidence

| Surface | Required evidence |
| --- | --- |
| Web Canvas | Shared entrypoints, invitation, role/capability state, actions and recovery through common components. |
| Web Desktop | Same complete business behavior and state/copy as Web Canvas. |
| Electron Desktop | Same behavior in packaged runtime; integration with native terminal/client routing. |
| Web Mobile | Same capability wherever the affected Chat/Terminal/project surface exists; adapted layout only. |
| Native Mobile | Supported dev client/native build, same identity/access/action rules wherever the capability exists. |
| CLI | Same scoped routing/identity and terminal/other applicable actions; no owner credential fallback. |

Record evidence per named surface. An unavailable underlying surface needs an explicit documented platform limitation; it cannot be silently omitted or marked passed. A milestone includes loading, empty, disabled, error and recovery states as well as success.

## Failure and rollback drill

1. Disable a later capability while an earlier milestone remains active. M2 off must preserve M1 discussion; M3 off must preserve owner process recovery; M4 off must not revive a writable private copy.
2. Use read_only to stop shared mutations while retaining authorized reads/export, or off to close participant access. Owner revoke/export/recovery remains available. Fence pending commands and preserve their truthful paused/interrupted states.
3. Restart gateway/platform and interrupt the directory worker. Stale routing metadata never grants access. Reconcile outbox and project publication journal idempotently; expired connections/control cannot regain permission automatically.
4. Confirm additive schemas and data remain intact. Never roll back to a binary that ignores scope/authority fences. A compatible rollback preserves one authority, shared history and protected backup references.

## Evidence record and promotion

Each milestone record includes merged PR/head SHAs, exact installed versions/profile generation, policy revision, named-surface results, full-path and real-Postgres race tests, runtime isolation evidence where relevant, known limitations, and the completed rollback drill. The implementation owner assembles the record; feature owner reviews enablement. Greptile 5/5 and required checks gate each merge. Public promotion additionally requires release-artifact verification. The four corresponding documentation updates in separate `FinnaAI/matrix-os-site` PRs under `content/docs/` accompany releases; they do not gate implementation merges or internal milestone enablement.

This plan has no implementation results. Planning validation checks document consistency, references, scope and dependencies only. The existing local `integrations-mcp` prerequisite build problem must be resolved in the implementation environment before treating repository typecheck/test gates as passed.
