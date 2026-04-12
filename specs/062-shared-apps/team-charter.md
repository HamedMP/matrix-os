# Team Charter — spec 062 (shared-apps)

> **All teammates: read this file first, every session.** It is the single source of truth for ownership, wave sequencing, and the rules that govern the team. The controller spawns you with a short prompt that points here.

Spec docs:
- `specs/062-shared-apps/spec.md`
- `specs/062-shared-apps/plan.md`
- `specs/062-shared-apps/tasks.md`

Branch: `062-shared-apps` — every teammate works directly on this branch. No worktrees. No feature branches.

---

## Roles and file ownership

One owner per hotspot file for the entire spec. **Never** edit a file owned by another teammate; if you need a change there, send the owner a message describing the diff you want.

| Name | Role | Owned files (exclusive) |
|---|---|---|
| `lead-integrator` | Lead Integrator — sequencing, server wiring, patch review, commit discipline | `packages/gateway/src/server.ts`, `specs/062-shared-apps/spec.md`, `specs/062-shared-apps/plan.md`, `specs/062-shared-apps/tasks.md`, `specs/062-shared-apps/manual-test.md`, this charter |
| `spike-guard` | Spike / Spec Guard — kill bad assumptions, keep spec aligned with measured behavior | `scripts/spike-*.ts`, `specs/062-shared-apps/spike.md`, early `specs/062-shared-apps/manual-test.md` scaffold (handed to Lead after Phase 1) |
| `matrix-transport` | Matrix transport surface, sync hub, ordering contract | `packages/gateway/src/matrix-client.ts`, `packages/gateway/src/matrix-sync-hub.ts`, `tests/gateway/matrix-client-extensions.test.ts`, `tests/gateway/matrix-sync-hub.test.ts` |
| `group-platform` | Group filesystem layout, schemas, lifecycle + ACL + share + data + members + presence routes | `packages/gateway/src/group-types.ts`, `packages/gateway/src/group-registry.ts`, `packages/gateway/src/group-routes.ts`, `tests/gateway/group-types.test.ts`, `tests/gateway/group-registry.test.ts`, `tests/gateway/group-routes-*.test.ts`, `tests/gateway/group-acl.test.ts`, `tests/gateway/group-members.test.ts`, `tests/gateway/group-presence.test.ts` |
| `crdt-engine` | Yjs sync engine, snapshots, lease, queue, ACL apply, op chunking, resource caps | `packages/gateway/src/group-sync.ts`, `tests/gateway/group-sync*.test.ts`, `tests/gateway/group-sync-lease.test.ts`, `tests/gateway/group-sync-conflict.property.test.ts`, `tests/gateway/group-sync-resources.test.ts`, `tests/gateway/yjs-version-compat.test.ts` |
| `kernel-ipc` | Kernel-side loopback IPC tools and allowlist | `packages/kernel/src/group-tools.ts`, `packages/kernel/src/ipc-server.ts` (group tool wiring sections only), `packages/kernel/src/options.ts` (`IPC_TOOL_NAMES` block), `tests/kernel/group-tools.test.ts` |
| `collab-shell` | WS bridge, shell mirror Y.Doc, shared hooks, group switcher, ACL panel, notes app shared mode | `packages/gateway/src/group-ws.ts`, `tests/gateway/group-ws.test.ts`, `shell/src/lib/group-bridge.ts`, `shell/src/lib/os-bridge.ts` (shared/group action types only), `shell/src/hooks/useSharedDoc.ts`, `shell/src/hooks/useSharedKey.ts`, `shell/src/hooks/useGroupMembers.ts`, `shell/src/components/GroupSwitcher.tsx`, `shell/src/components/AppAclPanel.tsx`, the chosen demo app's shared-mode integration, `tests/shell/os-bridge*.test.ts`, `tests/shell/useSharedDoc.test.tsx`, `tests/shell/useGroupMembers.test.tsx` |
| `qa-auditor` | E2E, coverage pushes, grep sweeps, failure-mode review, doc sync | `tests/e2e/shared-app.spec.ts`, `tests/e2e/screenshots/shared-app/`, audit notes in this charter's "Audit log" section. Read-mostly elsewhere. |

**Shared/coordinated files:** `package.json` and `pnpm-lock.yaml` get touched by `crdt-engine` (gateway add of yjs/lib0/y-protocols) and `collab-shell` (shell add of the same pinned versions). Each must commit `pnpm-lock.yaml` in the same commit per `feedback_commit_all_files.md`. They MUST coordinate via SendMessage so version pins stay identical. `lead-integrator` is the tiebreaker.

---

## Wave plan

Each wave is gated by the previous wave's checkpoint commits. Workers commit after each phase/feature; Lead verifies tests + lint + build before greenlighting the next wave.

### Wave 0 — Spike + scaffolding (parallel)

- `spike-guard`: Phase 1 of `tasks.md` (T001–T005). Deliverable: `specs/062-shared-apps/spike.md` with measured numbers and a written go/no-go. Throwaway scripts deleted before commit.
- `lead-integrator`: T017a (scaffold `manual-test.md` skeleton with section headers). Verify charter is up to date. Read every spec doc end to end.

**Wave 0 exit:** spike report committed with go decision; manual-test skeleton committed.

### Wave 1 — Foundational layer (parallel)

- `matrix-transport`: T006–T011 (`matrix-client.ts` extensions + `matrix-sync-hub.ts` + cursor persistence). TDD per phase.
- `group-platform`: T012–T015 (Zod schemas + GroupRegistry). TDD per phase. Includes `OpEventContent.chunk_seq` envelope shape so `crdt-engine` can rely on it in Wave 2.
- `kernel-ipc`: read the charter, prepare `tests/kernel/group-tools.test.ts` scaffolding around the eventual route shapes (no implementation until `group-platform` lands the routes).
- `lead-integrator`: T016, T017 — wire `MatrixSyncHub` + `GroupRegistry` into `server.ts` startup once both are available; smoke test boot. Then `feat(062): Matrix sync hub + group registry + shared types`.

**Wave 1 exit:** gateway boots clean, sync loop runs against an empty `~/groups/`, schemas frozen.

### Wave 2 — US1 lifecycle in parallel with US2 sync engine

- `group-platform`: T018, T020 (lifecycle routes + tests). Land `group-routes.ts` as the single source of truth for `/api/groups/*`.
- `kernel-ipc`: T019, T022, T023, T024 (lifecycle IPC tools + allowlist entries — only the four lifecycle names; do NOT yet add `set_app_acl`, `share_app`, `group_data`).
- `lead-integrator`: T021, T025 (mount routes in `server.ts`, run lint/build, commit checkpoint).
- `crdt-engine`: T026–T033a (Yjs deps, GroupSync core, queue, lease, snapshot reader/writer, op chunking, resource caps, cold-start perf). All work lives in `group-sync.ts` + sibling test files. Coordinate with `collab-shell` on yjs/lib0/y-protocols version pins.
- `lead-integrator`: T040, T041, T042 (wire `GroupSync` instances into `server.ts` startup, corrupt-state quarantine path, Docker smoke test).

**Wave 2 exit:** US1 functional (chat can create/join/list/leave groups). US2 functional (two GroupSync instances converge through a fake Matrix client). Two independent commits.

### Wave 3 — US3 collaboration shell + Kernel IPC ACL/share/data wiring (parallel)

- `collab-shell`: T043–T053 (WS server, shell mirror, hooks, GroupSwitcher). Coordinates with `crdt-engine` on shell yjs version pin (Task 5.1 = T046 mirrors gateway versions exactly).
- `kernel-ipc`: prepare ACL/share/data tool wrappers and tests in advance — wait to register them until `group-platform` lands the matching routes in Wave 4.
- `lead-integrator`: T048 (mount `/ws/groups/:slug/:app` in `server.ts`). Patch review across the slice.

**Wave 3 exit:** one iframe app reads/writes shared state across two browsers. Commit checkpoint.

### Wave 4 — ACL + share + members/presence/data (parallel within hotspot ownership)

- `group-platform`: extend `group-routes.ts` with ACL update (T058), share-app (T063), data (T078), members (T072), presence (T075). Tests in matching files.
- `crdt-engine`: extend `group-sync.ts` with ACL apply (T056), `m.matrix_os.app_install` handler (T064), `m.room.member` handler (T071), `m.presence` global handler (T074), `presence_changed`/`members_changed` broadcasts (via `collab-shell`'s `group-ws.ts` API).
- `kernel-ipc`: register `set_app_acl` (T057), `share_app` (T062), `group_data` (T079) tools and add the matching `IPC_TOOL_NAMES` entries.
- `collab-shell`: build `AppAclPanel.tsx` (T058a), `useGroupMembers.ts` (T077), `MatrixOS.group.onPresence` wiring in `group-bridge.ts` (T077a), `members_changed`/`presence_changed` WS subscriptions, ensure `MatrixOS.shared.onError` surfaces the five coarse codes (T044/T049).
- `lead-integrator`: serialize the per-file commit windows so two workers never push to the same hotspot simultaneously.

**Wave 4 exit:** US4 + US5 + US6 functional. Three checkpoint commits.

### Wave 5 — Demo app + e2e + polish (parallel)

- `collab-shell`: T082–T084 (notes app shared mode + share button).
- `qa-auditor`: T081, T085, T086 (Playwright spec, screenshots, manual-test.md fill-in alongside Lead).
- `lead-integrator`: T086 finalization + T100 user verification gate.
- `qa-auditor`: T088–T099, T101 (review skill, grep sweeps, coverage push, doc updates, PR draft).

**Wave 5 exit:** spec complete, PR opened, user verifies in Docker before push.

---

## Mandatory rules (every teammate, every commit)

These come from `CLAUDE.md` Mandatory Code Patterns and the project memory. Violations = bug. The QA auditor will grep for them.

1. **Atomicity:** 2+ related DB writes use a transaction. Use `ON CONFLICT` for idempotent upserts. Use `{flag:'wx'}` for exclusive file creates. State writes are tmp+rename.
2. **External calls:** every `fetch()` to an external service uses `signal: AbortSignal.timeout(ms)` (10s API, 30s file download, 60s cold /sync). Never expose provider names or raw error messages to clients.
3. **Input validation:** Hono `bodyLimit` middleware on every mutating endpoint. All user-supplied paths/identifiers go through `resolveWithinHome` / `SAFE_SLUG`. No wildcard CORS.
4. **Resource management:** every in-memory Map/Set has a size cap and eviction policy. Every temp file has a cleanup policy. `appendFileSync`/`writeFileSync` are banned in request handlers — use `fs/promises`.
5. **Error handling:** no bare `catch { return null }`. No empty `catch {}`. Webhook handlers return appropriate status codes.
6. **Wiring verification:** every IPC tool resolves its dependency at registration time, not at call time. Never use `globalThis` for cross-package communication — use constructor injection or typed IPC messages.
7. **TDD non-negotiable:** failing tests first, then implement. Red → Green → Refactor.
8. **Drizzle-only for SQLite kernel data;** social/app data goes through Postgres/Kysely. This spec uses neither — state lives in Matrix.
9. **Commit Conventional style:** `feat(062): ...`, `fix(062): ...`, `test(062): ...`, `chore(062): ...`. NO co-authored-by lines.
10. **Verify before done:** `bun run lint && bun run build` (and `bun run test` for the slice you touched) before saying you're finished. Never leave broken references, unused imports, or type errors.
11. **Commit cadence:** commit at every phase/feature checkpoint and at minimum every time tests for your slice are green. Do not let uncommitted work pile up.
12. **No worktrees** — banned. **No feature branches** — work directly on `062-shared-apps`. **No `docker compose down -v`** — volumes hold state.
13. **No surprise edits to other owners' files.** Send `lead-integrator` a message instead.

---

## Communication protocol

- Talk via `SendMessage` (refer to teammates by name). Plain text output is invisible to other agents.
- DM `lead-integrator` whenever a slice is green, blocked, or you need a cross-file change.
- Use `TaskUpdate` to mark tasks `in_progress` / `completed` and to claim ownership. Don't free-form status messages.
- DM the relevant owner directly if you need their help — don't go through Lead unless it's coordination across two owners.
- Idle is normal. Ignore your own idle notifications. The controller (or Lead) will wake you for the next assignment.

## Build baseline (recorded 2026-04-12 by lead-integrator)

`bun run build` (run from `packages/gateway/`) reports **39 pre-existing TypeScript errors** as of commit `ede8a27`, in files unrelated to spec 062 (`social.ts`, `telegram.ts`, `files-tree.ts`, `platform-db.ts`, `voice/stt/whisper.ts`, and a handful of legacy `server.ts` lines that predate this branch). These are NOT yours to fix. They are also NOT a free pass to ignore build output.

**No `lint` script** is defined at the repo root or in any package — `bun run lint` fails with "script not found". There is no ESLint runner wired up. Verification reduces to `bun run build` plus targeted `bun run test` vitest runs.

**How to verify your slice doesn't introduce new errors:**

1. **Count before editing.** `cd packages/gateway && bun run build 2>&1 | grep -c "error TS"` — capture the baseline count.
2. **Count after editing.** Same command — the count must match exactly. Any delta is yours to explain or fix.
3. **Stash+compare (lead's technique).** If you want to be certain, `git stash push -- <your-files>`, re-run the build, compare, then `git stash pop`. This isolates your delta even if someone else's commit lands while you're editing.
4. **Diff-aware filter.** `cd packages/gateway && bun run build 2>&1 | grep "error TS" | grep -E "(your-file-1|your-file-2)"` — should return zero lines.
5. **Per-slice files.** Zero errors are acceptable in any of these files (the active 062 surface): `matrix-client.ts`, `matrix-sync-hub.ts`, `group-types.ts`, `group-registry.ts`, `group-routes.ts`, `group-sync.ts`, `group-ws.ts` (future), `group-tools.ts` (kernel). If any of these lights up, fix before committing.

Never assume "the build was already broken" means your changes are clean. Always compare counts or filter by file. A commit that takes the baseline from 39 to 40 errors is a regression even if the build was already red — and the next agent will have a harder time spotting it than you do.

## Audit log (qa-auditor maintains)

_Last updated: 2026-04-12 by qa-auditor (Wave 5 sweeps + spec review + coverage + T082-T084 testid verification)_

### CRITICAL

- _none_

### HIGH

- ~~`packages/gateway/src/group-routes.ts:81` — `member_handles` regex~~  **FIXED** (committed, verified 2026-04-12).

- ~~`packages/gateway/src/group-routes.ts:439,460,515` — PATH param `:slug` missing GROUP_SLUG_REGEX guard in 3 routes~~ **FIXED** (commit `7b9e366`, all 7 slug-bearing routes verified at lines 221/244/298/386/440/462/518, 2026-04-12).

- ~~`tests/gateway/group-sync-conflict.property.test.ts:131` — property test timeout~~ **FIXED** (commit `f9f0a74`, verified green at 7284ms within 30s budget 2026-04-12).

- **T095 Coverage gaps** — All six 062 gateway files are below the spec-required thresholds. This unblocks a post-merge regression window. **Owners per file** (DM sent 2026-04-12):
  - `group-sync.ts`: 80.5% stmts / 60.2% branches (up from 79.3%/58%) — target ≥99% / ≥99% still not met. **Owner: crdt-engine.** C1 concurrent-mutation fix and F1 first_queued_at hydration landed at `a3efcb2` (verified correct). Remaining gaps: lines 243-261 (defaultFetchAppBundle — integration gap, not unit), lines 2127-2131 (ULID Math.random fallback — dead code in Node 24), plus snapshot-policy daemon and ACL-state handler paths. See crdt-engine DM for full analysis.
  - ~~`matrix-sync-hub.ts`: 86.6% stmts / 69.4% branches~~ **97.4% stmts / 87.9% branches / 95.3% funcs / 99.6% lines** (commit `cae3a28`, matrix-transport, 56 tests, verified 2026-04-12). Remaining 12% branch gap is structurally capped: defensive null-coalescing fallbacks (`?? {}`, `?? ''`, `?? 0`) on malformed Matrix homeserver responses + V8 closure-dispose artifacts. Single uncovered line: 207. Accepted as-is — fabricating deeply malformed MatrixSyncResponse objects adds fragility without meaningful safety gain.
  - `group-registry.ts`: 89.6% stmts / 66.7% branches — target ≥99% / ≥99%. **Owner: group-platform.** 64 uncovered statements, 12 branches. Key gaps at lines 17-68, 72, 85, 89, 97+ (slug derivation collision path, corrupt manifest quarantine, archive).
  - `group-routes.ts`: 90.5% stmts / 79.8% branches — target ≥95% / ≥95%. **Owner: group-platform.** 214 uncovered statements, 61 branches. Key gaps at lines 19-96 (schema-level edge cases, power level checks, error paths for presense/data/leave).
  - `group-ws.ts`: 80.3% stmts / 66.7% branches — target ≥95% / ≥95%. **Owner: collab-shell.** 129 uncovered statements, 31 branches. Key gaps at lines 95-182 (WebSocket handler construction, upgrade path, error close paths).
  - ~~`group-tools.ts`: 96.9% stmts / 82.4% branches~~ **100% stmts / 100% branches / 100% funcs / 100% lines** (commit `a9bf882`, kernel-ipc, verified 2026-04-12, 62 tests).

- ~~**T088/spec review finding I1** — In-process integration test missing.~~ **DEFERRED** (lead-integrator decision 2026-04-12). 7 scenarios are triple-covered by: (a) unit-with-stubs in group-sync*.test.ts + group-routes-*.test.ts + group-ws.test.ts, (b) Playwright e2e scaffold, (c) manual-test.md T100 Docker scenarios. A fourth layer would require real conduit container + vitest-container orchestration (~400-800 LOC). If T100 surfaces an integration gap the layered tests missed, a targeted test will be added in the follow-up PR.

- ~~**T088/spec review finding W1** — Runtime join wiring gap (late-registered GroupSync may miss events).~~ **FIXED in spec** (commit `3dcd1b6`, lead-integrator 2026-04-12). `MatrixSyncHub.registerEventHandler` is now an explicit post-`start()` contract in §Integration Wiring with 4 guarantees: per-room map race safety, recency-ring gap coverage, route-registers-before-200-response, register-after-start test required.

### MED

- ~~`packages/gateway/src/group-routes.ts:79-92` — inline body schemas~~ **FIXED** (commit `e3f4726`, group-platform, 2026-04-12). `CreateGroupBodySchema`/`JoinGroupBodySchema`/`ShareAppBodySchema` exported from `group-types.ts:140/145/149`, imported in `group-routes.ts:6`. `SAFE_APP_SLUG` duplicate removed in favour of `GROUP_SLUG_REGEX`. 214 tests green.

- ~~**T088/spec review S2** — Spec §H WS mid-connection token expiry undefined.~~ **FIXED in spec** (commit `3dcd1b6`, 2026-04-12). Gateway re-checks ACL per-message, closes 4403 `acl_denied` on downgrade. Token rotation = shell reopens socket. Hard mid-conn expiry is explicit non-goal for v1.

- ~~**T088/spec review F1** — Queue escalation clock resets on restart (`first_queued_at` missing).~~ **FIXED** in spec (`3dcd1b6`) and implementation (`a3efcb2`, crdt-engine, 2026-04-12). `hydrateApp` reads oldest `queue.jsonl` entry's `queued_at` and restores `firstFailureAt` on boot. Restart-after-31min test verifies escalation fires immediately.

- ~~**T088/spec review C1** — Concurrent local mutations: spec didn't say mutations are serialized.~~ **FIXED in spec** (commit `3dcd1b6`, 2026-04-12, covered under snapshot rejection §C amendment). crdt-engine to verify implementation matches. DM sent 2026-04-12.

- ~~**T088/spec review S4** — inline `SAFE_APP_SLUG` duplicate of canonical regex~~ **FIXED** (commit `e3f4726`, group-platform, 2026-04-12). Removed `SAFE_APP_SLUG`, now uses `GROUP_SLUG_REGEX` throughout.

- ~~`shell/src/components/GroupSwitcher.tsx` — No `data-testid` attributes on any interactive element.~~ **FIXED** by collab-shell (commit `8dfae42`, 2026-04-12). `data-testid="group-switcher-trigger"` (line 47), `data-testid="group-switcher-item-personal"` (line 60), `data-testid="group-switcher-item-{slug}"` (line 71). `home/apps/notes/index.html`: `data-testid="share-group-item-{slug}"` (line 1360), `data-testid="app-notes-share-button"` (line 1392). Playwright e2e spec updated to use these testids directly (step 02-03 assertions); steps 4-9 remain skipped pending live backend.

- Two-context Clerk auth not wired for e2e: `E2E_TEST_BYPASS=1` is in the shell's `playwright.config.ts` and skips Clerk. For the full two-user shared-app flow (steps 4–9) this means both contexts share the same identity. True two-user e2e needs real Clerk test users or a stub identity fixture injected per context. Filed as a known gap in `tests/e2e/shared-app.spec.ts` header comment. T082-T084 have now landed; steps 4-9 remain skipped pending live backend. Auth gap still open. **Owner: lead-integrator** (DM sent 2026-04-12).

### LOW

- `packages/gateway/src/group-ws.ts:123` — `subscriberSets` (outer `Map<string, Set<ConnState>>`) grows without a cap on the number of distinct `(group:app)` keys. Each unique `slug:app` creates a permanent entry even after all subscribers disconnect. For a single-user deployment this is negligible, but for a multi-tenant deployment it is an unbounded map. The inner `Set` per key is capped via `maxSockets`. **Owner: collab-shell** (DM sent 2026-04-12). Fix: sweep entries with empty sets on subscriber removal; or periodically evict empty keys.

- T090 sweep: Two `globalThis` usages found in `group-snapshot-lease.ts:73` and `group-sync.ts:2127`. Both are a crypto polyfill (`globalThis.crypto?.getRandomValues`) for ULID generation in environments that lack `crypto` (tests). This pattern reads `globalThis` for a platform API, not for cross-package communication — this is acceptable per the mandatory rule spirit. `matrix-client.ts:6` uses `globalThis.fetch` only as a type reference in a config interface. None of these are violations. Documented for completeness.

- T092 sweep: All `fetch()` calls in the 062 surface have `AbortSignal.timeout(...)` either directly or via the `MatrixClient` wrapper (which applies a configurable timeout to every method). No bare un-timed external fetches found.

- T091 sweep: No `appendFileSync` or `writeFileSync` in request handlers or the sync loop. All filesystem I/O uses `fs/promises`. Clean.

- T093 sweep: All mutating routes in `group-routes.ts` have `bodyLimit` middleware with the correct limits (lifecycle routes 256KB, data route 512KB, leave route 1KB). Clean.

### Spec review verdict (T088, 2026-04-12)

`/review-spec specs/062-shared-apps/spec.md` — **WARN** (0 CRITICAL, 6 HIGH, 7 MED, 3 LOW). Full report output in qa-auditor session. HIGH findings filed above. Constitution principle VIII satisfied (auth matrix exists, input validation specified, no wildcard CORS, no internal leaks). Main gaps: runtime join wiring, WS token expiry, queue clock persistence, coverage.

**Status 2026-04-12**: All 6 HIGH spec gaps closed (commit `3dcd1b6`). All 2 HIGH code gaps closed (group-platform commits). I1 deferred. Remaining open: MED T094 (schema move, group-platform in progress), MED F1 implementation (crdt-engine), coverage gaps (T095, owners have DMs).

### Pre-existing failures (NOT 062)

8 test failures exist in the full suite that predate this spec: `tests/shell/desktop-config.test.ts` (2), `tests/shell/theme-presets.test.ts` (3), `tests/shell/useTheme.test.ts` (1), `tests/gateway/voice/tts/fallback.test.ts` (2). None are in 062-owned files. The property test timeout (1 failure) was fixed by crdt-engine commit `f9f0a74`.

### Build baseline delta (2026-04-12)

Pre-sweep: 39 TS errors (recorded in charter §Build baseline). Post-sweep: qa-auditor made no implementation changes — error count unchanged. New files added: `tests/e2e/shared-app.spec.ts` (Playwright, no gateway TypeScript compilation), `tests/e2e/screenshots/shared-app/` (empty directory). Zero new TS errors introduced.

---

## Open coordination questions

(Lead and Spike Guard fill these in as Wave 0/1 progress.)

- yjs / lib0 / y-protocols exact versions — set in T034, copied to shell in T046.
- Demo app pick — recommend `~/apps/notes`, confirm with user before T082.
- Spike open questions #1–#5 from spec.md → answers feed `crdt-engine` lease + chunk size constants.
