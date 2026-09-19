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
- Rebased source: `origin/main` at `9d46c4428`, including the subsequently merged collaboration realtime, terminal, and immutable provider-ownership fixes.
- Manual worktree: `/home/nima/matrix-os-collaboration-ux-redesign` on branch `525-collaboration-ux-redesign`.
- Original checkout `/home/nima/matrix-os` contained unrelated user changes and remains untouched.
- Dependencies installed with the frozen lockfile using the existing offline store.
- Current-main verification: `pnpm --dir shell exec playwright test e2e/shared-chat.spec.ts` passed (1 test).
- Ignored baseline captures: `output/playwright/shared-chat/web-desktop-discussion.png`, `web-desktop-ai.png`, and `web-canvas-ai.png`.
- Observed baseline: collaboration-specific duplicate header, card transcript, Discussion/Ask AI composer switch, persistent queue weight, and Shared with me outside the Chat rail.

## Stack

1. `feat(collaboration): add discussion and invitation UX contracts` — 28 files, 2,926 additions.
2. `feat(collaboration): integrate native web session UX` — 50 files, 2,183 additions plus current screenshot evidence.
3. `feat(collaboration): align desktop and mobile session UX` — 48 files, 1,906 additions after final verification, provider-ownership alignment, and Electron evidence.

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
- Native-web review remediation: added failing regressions for capability-off navigation, discovery failure persistence, refreshed scope revisions, bounded discussion pagination/read receipts, discussion-trigger toggling, access-summary light dismiss, hostile draft storage, collaboration-identity changes during in-flight requests, canonical shared-terminal routing, centralized overlay layering, mobile terminal-cap routing/retry, and synchronous private-draft identity switching. The final 12-file native-web rerun passed 64/64 tests; the focused canonical route/window suite passed 64/64; UI and shell TypeScript checks passed; and the full stack pattern scan reported zero violations. `Shared with me` now checks the authoritative runtime capability before mounting discovery, remains available without a badge through transient inbox failures, and never queries discovery while disabled. Access mutations receive the newest validated scope revision, and the summary supports same-trigger close, Escape, outside-pointer dismiss, and focus restoration. Discussion loads subsequent 100-note pages explicitly and advances personal read state only through the last rendered note. Identity generations fence late page, subscription, and send results so one session or account cannot publish into another session's UI, and private drafts synchronously adopt the new actor/runtime/scope key before paint. Shared terminal launches now use the canonical `__terminal__` app path and carry the validated collaboration scope only as serializable window/app metadata. At Web Mobile's five-terminal limit, a matching shared scope is focused and a different requested scope is rejected with a capacity notice instead of substituting an unrelated terminal; rejected deep links remain pending and retry when terminal capacity becomes available. Draft parsing and cleanup failures remain private, non-fatal, and safely logged by error kind. Chat and terminal discussion triggers now toggle with accurate expanded state. Shared collaboration popovers and drawers receive shell-owned `SHELL_Z_INDEX` layers rather than embedding local stacking values. React Doctor scanned all seven configured React projects (4,015 files); its repository-wide baseline was 884 findings, with intentional suppressions recorded for the runtime-local capability probe and identity-bound discussion reset. Its final 12-file shared-UI changed-scope rerun reported only five documented baseline warnings; the score API was unavailable. The final 17-file changed-scope shell rerun reported only five documented maintainability warnings; the score API was unavailable.

### Native web and shared layers

- Red/green: projection, two-account, private-draft, access, discussion, normal-Chat, deep-link, native terminal-route, and sharing suites were introduced or extended before their paired implementations. The final current-head native-web rerun passed 64 tests across 12 files.
- Canvas/browser: `PLAYWRIGHT_DEV_SERVER=1 PLAYWRIGHT_PORT=3017 ... playwright test e2e/shared-chat.spec.ts` passed both current-head cases and captured Web Desktop, Canvas, Shared with me discovery/pending/native-open, 390×844 responsive Chat/discussion/access, and provider-unavailable states under `output/playwright/collaboration-ux/`.
- Presentation: shared prompts use the normal right-side human presentation with attribution; AI remains left; the ordinary `Message Chat` composer creates shared AI requests; human discussion is excluded from the AI timeline; queue detail is progressive; the responsive discussion layer overlays without resizing the session.
- Routing/discovery: legacy shared URLs resolve into Chat or Terminal shell state; Shared with me is in Chat navigation with pending invalidation; snapshot and live-invite entry points remain distinct; feature-off tests prove controls are absent.
- Types: `packages/ui` and `shell` TypeScript checks passed. The shell production build compiled and typechecked but cannot complete prerender in this environment without a real Clerk publishable key.
- React Doctor: required scans were run for shared UI and shell. Earlier score-service results were 58 and 36; the final local rerun scanned successfully but its optional remote score API was unreachable. Findings were dominated by existing large components/custom dialog heuristics; the new render-time ref mutation and async dependency warnings were corrected.

### Electron and mobile parity

- Electron: 45 focused native routing/work-surface tests passed; the desktop TypeScript check and production Electron build passed. After the final rebase, the Xvfb Electron journey passed again and captured the native Chat header plus opaque discussion drawer under `output/playwright/shared-chat/`.
- A visual verification cycle found and fixed three issues beyond selector assertions: missing shared title, collaboration utilities omitted from Desktop Tailwind source discovery, and discussion state resetting when a metadata callback changed identity.
- Review remediation: added failing regressions for ordinary shell-session reconciliation deleting a native shared-terminal tab, an inbox-count failure hiding the only Electron discovery entry point, and Electron wrappers bypassing centralized overlay layers. Shared terminals are now excluded from only that unrelated reconciliation, while the discovery row remains available and degrades only its badge. Chat and terminal collaboration surfaces receive `DESKTOP_Z_INDEX` dialog/popover values. The focused desktop rerun passed 15/15 tests; Desktop typecheck and the full-stack pattern scan passed; React Doctor's 10-file changed-scope scan reported only four pre-existing complexity warnings outside the overlay wrappers, while the 414-file project scan retained its documented repository-wide baseline and the optional score API was unreachable.
- Mobile: 8 Jest suites passed 46 tests for discovery, feature gating, invitation actions, ordinary shared AI composition, owner-runtime unavailability, discussion drafts/sheet behavior, access, and terminal collaboration. Async close/unmount guards and stable effect dependencies were added after React Doctor findings. The final provider-ownership rebase also removed participant-supplied model selection from mobile requests and consumes the owner-derived capability projection.
- Mobile static check: the app-wide TypeScript check still reports the repository's existing React Native dependency JSX incompatibilities; no changed collaboration file appeared in the diagnostics. React Doctor ran and scored 49 after the new dependency warnings were corrected.
- Physical-device evidence is not claimable from this Linux worktree. T098 and review-ready status remain open until an Expo device capture is attached.

### Documentation

- Separate worktree: `/home/nima/matrix-os-site-collaboration-docs`, branch `525-collaboration-ux-docs`, based on docs `origin/main` at `4a5b35c`.
- Added `content/docs/collaboration.mdx` and navigation metadata covering discovery, native Chat, discussion, roles/access, terminal control, snapshot separation, and privacy boundaries.
- Draft docs PR: `FinnaAI/matrix-os-site#116`. All 37 Node test files pass after installing the frozen lockfile; Vercel and CodeRabbit checks passed and the committed preview evidence is `public/images/collaboration-docs-preview.png`.

### Remaining delivery gates

- `$worktree-pr-monitor` is not installed in the available skill catalog or local skill directories; PR monitoring must use the repository's `gh pr checks`/Graphite fallback unless the skill is supplied.
- Draft code stack: `HamedMP/matrix-os#1751` → `#1752` → `#1753`. All three carry `ready-for-ci`; PR 1 has current-head Greptile 5/5 with all CI checks green, while the freshly updated PR 2/PR 3 reviews are still in flight.
- Physical mobile evidence and the resulting non-draft transition remain open; no Expo device is attached to this runner.
- No branch has been merged; explicit product-owner approval remains mandatory.
