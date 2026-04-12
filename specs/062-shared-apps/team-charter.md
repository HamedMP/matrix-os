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

## Audit log (qa-auditor maintains)

- _empty_

---

## Open coordination questions

(Lead and Spike Guard fill these in as Wave 0/1 progress.)

- yjs / lib0 / y-protocols exact versions — set in T034, copied to shell in T046.
- Demo app pick — recommend `~/apps/notes`, confirm with user before T082.
- Spike open questions #1–#5 from spec.md → answers feed `crdt-engine` lease + chunk size constants.
