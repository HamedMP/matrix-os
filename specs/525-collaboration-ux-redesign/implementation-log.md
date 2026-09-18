# Implementation Log: Native Collaboration UX Redesign

## Confirmed Interaction Model

Confirmed by the product owner on 2026-09-17.

- Shared Chat uses the ordinary Matrix timeline, composer, AI rendering, and responsive frame.
- Desktop human discussion is a right-side in-session overlay drawer; mobile is a full-height bottom sheet.
- Access uses one compact summary popover and an owner-only second-level manager; discussion has a separate trigger.
- Shared with me is a first-class Chat navigation row with a bounded pending badge and no separate app/dock icon.
- Shared terminals retain the ordinary terminal viewport with compact access, discussion, role, and controller controls.

## Baseline

- Original baseline: `origin/main` at `8b36039aa` (`feat(collaboration): resolve invitation identifiers (#1741)`).
- Rebased source: `origin/main` at `b1fd8ed37`, including the subsequently merged collaboration realtime and terminal fixes.
- Manual worktree: `/home/nima/matrix-os-collaboration-ux-redesign` on branch `525-collaboration-ux-redesign`.
- Original checkout `/home/nima/matrix-os` contained unrelated user changes and remains untouched.
- Dependencies installed with the frozen lockfile using the existing offline store.
- Current-main verification: `pnpm --dir shell exec playwright test e2e/shared-chat.spec.ts` passed (1 test).
- Ignored baseline captures: `output/playwright/shared-chat/web-desktop-discussion.png`, `web-desktop-ai.png`, and `web-canvas-ai.png`.
- Observed baseline: collaboration-specific duplicate header, card transcript, Discussion/Ask AI composer switch, persistent queue weight, and Shared with me outside the Chat rail.

## Stack

1. `feat(collaboration): add discussion and invitation UX contracts` — 29 files, 2,650 additions.
2. `feat(collaboration): integrate native web session UX` — 39 files, 1,304 additions.
3. `feat(collaboration): align desktop and mobile session UX` — 25 files, 1,436 additions before final verification-only edits.

Each layer must remain at or below 3,000 additions and 50 files, include current-head evidence for visible changes, pass its relevant checks, use `$worktree-pr-monitor`, reach Greptile 5/5, and stay unmerged until explicit product-owner approval.

## Red/Green and Validation Record

Commands and results are appended here as tasks complete. No production implementation begins before its paired failing test has been observed failing for the intended missing behavior.

### Phase 2 — foundational contracts

- Red: the initial 9-file Vitest batch failed in 12 intended places because the decline schemas/repository method, scope discussion adapter/routes/tables, proxy/CLI patterns, and migration version did not exist. Existing wiring tests also hit the expected sandbox-only Unix-socket restriction.
- Green: the 10-file Phase 2 Vitest command passed 99 tests across 9 files; the 6 real-PostgreSQL cases were skipped because no PostgreSQL test URL was configured. A supplemental terminal export/deletion test passed, bringing that focused file to 3 passing cases.
- Types: contracts, gateway, platform, and sync-client TypeScript checks passed.
- Pattern scan: `pnpm check:patterns:diff` passed with zero violations; reported warnings were repository-wide review reminders and no new unsafe pattern was introduced.
- Backend invariants: the owner runtime remains authoritative; decline is target-only and revision-locked; discussion reauthorizes in the write/read transaction; Chat notes remain canonical `purpose=discussion` rows; terminal notes are owner-local and cascade with their scope; terminal export projection is bounded and excludes actor-local read state; snapshots cannot authenticate live routes; directory outbox remains content-free; queue and terminal-control authority are unchanged.
- Size at verification: 18 changed files and roughly 650 additions, below the Stack PR 1 limits.
- Review remediation: added red tests proving participant resolution occurs before the terminal scope-locking transaction, Chat discussion cursors remain independent from ordinary Chat read state, and terminal notes round-trip through the signed owner lifecycle/export routes. A follow-up concurrency regression commits a note between export preparation and scope locking and proves the transaction-local export read includes it. The focused export/route rerun passed 30/30 tests. The broader 10-file foundation run passed all 104 executable tests with 6 real-Postgres cases skipped for missing `MATRIX_TEST_POSTGRES_URL`; its two sandbox-blocked Unix-socket cases passed 7/7 when rerun outside the sandbox. Contracts, gateway, platform, and sync-client typechecks passed, and the pattern scan reported zero violations. Terminal export reuses existing owner authorization, lifecycle operation/audit, expiring export storage, and retrieval; it adds no authority or public token path.
- Native-web review remediation: added failing regressions for capability-off navigation, discovery failure persistence, refreshed scope revisions, bounded discussion pagination/read receipts, discussion-trigger toggling, and hostile draft storage. The final 12-file native-web rerun passed 59/59 tests; UI and shell TypeScript checks passed; and the full stack pattern scan reported zero violations. `Shared with me` now checks the authoritative runtime capability before mounting discovery, remains available without a badge through transient inbox failures, and never queries discovery while disabled. Access mutations receive the newest validated scope revision. Discussion loads subsequent 100-note pages explicitly and advances personal read state only through the last rendered note. Draft parsing and cleanup failures remain private, non-fatal, and safely logged by error kind. Chat and terminal discussion triggers now toggle with accurate expanded state. React Doctor scanned all seven configured React projects (4,015 files); its repository-wide baseline was 884 findings, with intentional suppressions recorded for the runtime-local capability probe and identity-bound discussion reset.

### Native web and shared layers

- Red/green: projection, two-account, private-draft, access, discussion, normal-Chat, deep-link, native terminal-route, and sharing suites were introduced or extended before their paired implementations. The focused current-head rerun passed 9 discussion/access/shell tests and the broader shared UI/desktop rerun passed 63 tests.
- Canvas/browser: `PLAYWRIGHT_DEV_SERVER=1 PLAYWRIGHT_PORT=3017 ... playwright test e2e/shared-chat.spec.ts` passed at current head and captured Web Desktop, Canvas, Shared with me discovery/pending/native-open, and 390×844 responsive Chat, discussion, and access states under `output/playwright/collaboration-ux/`.
- Presentation: shared prompts use the normal right-side human presentation with attribution; AI remains left; the ordinary `Message Chat` composer creates shared AI requests; human discussion is excluded from the AI timeline; queue detail is progressive; the responsive discussion layer overlays without resizing the session.
- Routing/discovery: legacy shared URLs resolve into Chat or Terminal shell state; Shared with me is in Chat navigation with pending invalidation; snapshot and live-invite entry points remain distinct; feature-off tests prove controls are absent.
- Types: `packages/ui` and `shell` TypeScript checks passed. The shell production build compiled and typechecked but cannot complete prerender in this environment without a real Clerk publishable key.
- React Doctor: required scans were run for shared UI and shell. Earlier score-service results were 58 and 36; the final local rerun scanned successfully but its optional remote score API was unreachable. Findings were dominated by existing large components/custom dialog heuristics; the new render-time ref mutation and async dependency warnings were corrected.

### Electron and mobile parity

- Electron: 45 focused native routing/work-surface tests passed; the desktop TypeScript check and production Electron build passed. The Xvfb Electron journey passed and captured the native Chat header plus opaque discussion drawer under `output/playwright/shared-chat/`.
- A visual verification cycle found and fixed three issues beyond selector assertions: missing shared title, collaboration utilities omitted from Desktop Tailwind source discovery, and discussion state resetting when a metadata callback changed identity.
- Mobile: 8 Jest suites passed 45 tests for discovery, feature gating, invitation actions, ordinary shared AI composition, discussion drafts/sheet behavior, access, and terminal collaboration. Async close/unmount guards and stable effect dependencies were added after React Doctor findings.
- Mobile static check: the app-wide TypeScript check still reports the repository's existing React Native dependency JSX incompatibilities; no changed collaboration file appeared in the diagnostics. React Doctor ran and scored 49 after the new dependency warnings were corrected.
- Physical-device evidence is not claimable from this Linux worktree. T098 and review-ready status remain open until an Expo device capture is attached.

### Documentation

- Separate worktree: `/home/nima/matrix-os-site-collaboration-docs`, branch `525-collaboration-ux-docs`, based on docs `origin/main` at `4a5b35c`.
- Added `content/docs/collaboration.mdx` and navigation metadata covering discovery, native Chat, discussion, roles/access, terminal control, snapshot separation, and privacy boundaries.
- Docs validation: all 37 Node test files pass after installing the frozen lockfile. The Next production build began successfully and generated MDX, but was stopped after the optimized build stage made no progress for several minutes in the constrained runner.

### Remaining delivery gates

- `$worktree-pr-monitor` is not installed in the available skill catalog or local skill directories; PR monitoring must use the repository's `gh pr checks`/Graphite fallback unless the skill is supplied.
- PR submission, current-head CI, `ready-for-ci`, Greptile 5/5, physical mobile evidence, and non-draft transition are intentionally not recorded as complete until actually achieved.
- No branch has been merged; explicit product-owner approval remains mandatory.
