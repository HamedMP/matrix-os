# Implementation and Internal Acceptance Guide

This is a future implementation guide, not instructions for an already-shipped feature. The planning PR changes no runtime, cohort, deployment or user data. Start with the [delivery plan](delivery-plan.md); expand individual slices using `/speckit-tasks` when implementation is requested.

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
