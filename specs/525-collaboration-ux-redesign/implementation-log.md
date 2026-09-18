# Implementation Log: Native Collaboration UX Redesign

## Confirmed Interaction Model

Confirmed by the product owner on 2026-09-17.

- Shared Chat uses the ordinary Matrix timeline, composer, AI rendering, and responsive frame.
- Desktop human discussion is a right-side in-session overlay drawer; mobile is a full-height bottom sheet.
- Access uses one compact summary popover and an owner-only second-level manager; discussion has a separate trigger.
- Shared with me is a first-class Chat navigation row with a bounded pending badge and no separate app/dock icon.
- Shared terminals retain the ordinary terminal viewport with compact access, discussion, role, and controller controls.

## Baseline

- Source: `origin/main` at `8b36039aa` (`feat(collaboration): resolve invitation identifiers (#1741)`).
- Manual worktree: `/home/nima/matrix-os-collaboration-ux-redesign` on branch `525-collaboration-ux-redesign`.
- Original checkout `/home/nima/matrix-os` contained unrelated user changes and remains untouched.
- Dependencies installed with the frozen lockfile using the existing offline store.
- Current-main verification: `pnpm --dir shell exec playwright test e2e/shared-chat.spec.ts` passed (1 test).
- Ignored baseline captures: `output/playwright/shared-chat/web-desktop-discussion.png`, `web-desktop-ai.png`, and `web-canvas-ai.png`.
- Observed baseline: collaboration-specific duplicate header, card transcript, Discussion/Ask AI composer switch, persistent queue weight, and Shared with me outside the Chat rail.

## Stack

1. `feat(collaboration): add discussion and invitation UX contracts`
2. `feat(chat): make shared sessions native`
3. `feat(collaboration): add native session layers`
4. `feat(collaboration): complete native terminal and discovery`
5. `feat(collaboration): align desktop and mobile surfaces`

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
