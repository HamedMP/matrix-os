---
description: "Task list for spec 062 — shared apps via CRDT over Matrix"
---

# Tasks: Shared Apps (CRDT over Matrix)

**Input**: `/specs/062-shared-apps/` — spec.md, plan.md
**Prerequisites**: plan.md ✓, spec.md ✓
**Testing**: Tests included — TDD is constitutionally non-negotiable (Principle V, CLAUDE.md)

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and validated independently. User stories are derived from the implementation chunks in plan.md and the six capabilities listed in spec.md's "Problem" section.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable — different file, no dependency on incomplete tasks in the same phase
- **[Story]**: Maps task to user story (US1–US7) for traceability
- File paths are exact; same-file tasks are sequential even if in the same phase

## Path Conventions

Matrix OS monorepo: `packages/gateway/src/`, `packages/kernel/src/`, `shell/src/`, `tests/` at repo root, `specs/062-shared-apps/` for spec artifacts.

---

## Phase 1: Setup (Spike — BLOCKING)

**Purpose**: Verify core Matrix + Yjs assumptions before committing to the architecture. Per CLAUDE.md "spike before spec", Phase 1 cannot complete until spike.md commits a go decision.

- [ ] T001 Provision two Matrix test accounts on matrix-os.com Synapse (or local docker compose), capture homeserver URL + access tokens in `.env.spike` (gitignored)
- [ ] T002 [P] Create throwaway round-trip script `scripts/spike-matrix-roundtrip.ts`: A creates room, invites B, sends 100 custom events, measure p50/p95/p99/max latency and rate-limit responses; repeat with 16KB, 32KB, 64KB payloads
- [ ] T003 [P] Create throwaway Yjs script `scripts/spike-yjs-matrix.ts`: two `Y.Doc` instances exchange updates via Matrix custom events, verify semantic convergence under concurrent mutation, verify snapshot writer/reader round-trip
- [ ] T004 Write `specs/062-shared-apps/spike.md` with latency tables, max payload size, rate limit thresholds, Yjs convergence verdict, open-question answers, and a signed go/no-go decision for Phase 2
- [ ] T005 Delete throwaway spike scripts from `scripts/`, commit spike.md only

**Checkpoint**: Spike report committed, go decision recorded. Phase 2 cannot begin without this.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the Matrix sync layer, Zod schemas, and group filesystem registry that every user story depends on. No user-visible behavior yet.

**⚠️ CRITICAL**: No user story work (Phases 3+) begins until this phase is complete.

- [ ] T006 Write failing unit tests in `tests/gateway/matrix-client-extensions.test.ts` for `sync()`, `createRoom`, `inviteToRoom`, `kickFromRoom`, `leaveRoom`, `getRoomState`, `getAllRoomStateEvents`, `setRoomState`, `getRoomMembers`, `getPowerLevels`, `setPowerLevels` — covering typed errors (`MatrixForbiddenError`, `MatrixNotFoundError`, `MatrixRateLimitError`, `MatrixUnknownError`), `AbortSignal.timeout()` on every method, `presence` top-level field on `/sync`, no subscription/dispatch API in this layer
- [ ] T007 Implement the new methods in `packages/gateway/src/matrix-client.ts` behind the existing `createMatrixClient` factory; translate `errcode` to typed errors; do not leak raw response text
- [ ] T008 Write failing tests in `tests/gateway/matrix-sync-hub.test.ts` for `MatrixSyncHub`: `start(signal)` long-poll loop, `next_batch` threading, abort-clean shutdown, backoff (1s/2s/4s/30s cap), `registerEventHandler(roomId, eventType, handler)` per-room serial dispatch, `registerGlobalEventHandler(eventType, handler)` global queue dispatch, and the four-point ordering contract (per-room serial, cross-room parallel, global-queue serial, NO cross-stream total order)
- [ ] T008a Write failing tests in `tests/gateway/matrix-sync-hub.test.ts` for the **gap-fill contract (spec §E.1, spike §9.1 — NON-NEGOTIABLE Wave 1 blocker)**: (1) **per-room recency ring** caps at 256 events with LRU eviction; (2) **mid-burst-gap regression** — feed a fake `/sync` response that skips event N (with `limited: false` on every batch), seed the fake `/messages` store with event N, assert the hub pauses room dispatch, backfills via `/messages?dir=b&from=<prev>&limit=500`, sorts results by `(origin_server_ts, event_id)`, delivers event N in order to registered handlers, then resumes /sync; (3) **`reportGap(roomId, expectedLamport)` callback path** — simulate an inbound op whose lamport skips forward for a given client_id, assert the hub reacts without needing `limited: true`; (4) **failure path** — backfill fetch times out or returns 5xx, hub surfaces `sync_failed` via the onError channel, does NOT advance stored `next_batch` past the gap, retries on next loop; (5) **iteration cap** of 8 `/messages` pages before surfacing `sync_failed`; (6) **`limited: true` signal path** — a batch that explicitly reports truncation triggers the same backfill code path as the silent-gap detection
- [ ] T009 Implement `packages/gateway/src/matrix-sync-hub.ts` with per-room chained promise queues, single global queue, `for await` loop (no `setInterval`); encode the ordering contract in JSDoc. **Implement the gap-fill contract from spec §E.1 end-to-end**: per-room recency ring (cap 256 events, LRU eviction — size cap is NON-NEGOTIABLE per CLAUDE.md mandatory resource caps), `reportGap(roomId, expectedLamport)` API, `limited: true` detection, `/messages?dir=b&from=<prev>&limit=500` backfill loop with 8-page iteration cap, `(origin_server_ts, event_id)` tiebreak sort before dispatch, pause/resume room dispatch around backfill, `sync_failed` onError surfacing on backfill failure, do NOT advance stored `next_batch` past an unclosed gap. Every `fetch` in this path uses `AbortSignal.timeout(10000)` per CLAUDE.md mandatory external-call pattern.
- [ ] T010 Add /sync cursor persistence tests to `tests/gateway/matrix-sync-hub.test.ts`: read `~/system/matrix-sync.json` on startup, atomic tmp+rename on every successful /sync, null-fallback on corrupt cursor
- [ ] T011 Implement cursor persistence in `packages/gateway/src/matrix-sync-hub.ts`
- [ ] T012 [P] Write failing Zod tests in `tests/gateway/group-types.test.ts` for `GroupManifest`, `GroupAcl`, `OpEventContent` (**including the optional `chunk_seq: { index: number; count: number; group_id: string (ULID) }` field required by T032a/T035a — must accept both single-event and fragmented-event shapes, reject `index >= count`, reject `count > 32` (hard upper bound on fragmentation fan-out), require `group_id` to match the ULID regex**), `SnapshotEventContent`, `SnapshotLeaseContent`, `GroupDataValueSchema` (recursive with `z.lazy()`, rejects `undefined`/functions/`Date`/`BigInt`/cycles, depth cap 16, serialized size 256 KB), `GroupDataRequestSchema` (conditional `key`/`value`), group-slug regex, handle regex
- [ ] T013 [P] Implement `packages/gateway/src/group-types.ts` using `import { z } from 'zod/v4'`; `OpEventContent` exposes `chunk_seq` as an optional object so that existing single-event ops continue to parse unchanged and the reassembly path in T035a has a single source of truth for the fragment envelope shape. The schema is deliberately defined here (Phase 2) rather than delayed until Phase 4 so that downstream chunks cannot silently implement chunked ops against an ad-hoc inline schema
- [ ] T014 [P] Write failing tests in `tests/gateway/group-registry.test.ts` for `GroupRegistry`: empty dir, single valid group, corrupt manifest quarantine, `create({ roomId, name, ownerHandle })`, `get(slug)`, `archive(slug)`, all writes through `resolveWithinHome`
- [ ] T015 [P] Implement `packages/gateway/src/group-registry.ts` using `fs/promises` and atomic tmp+rename writes
- [ ] T016 Wire `MatrixSyncHub` + `GroupRegistry` into `packages/gateway/src/server.ts` startup (after existing `matrixClient` singleton): `new MatrixSyncHub(matrixClient)`, `new GroupRegistry(homePath)`, `await groupRegistry.scan()`, `syncHub.start(shutdownAbortController.signal)` after handler registration
- [ ] T017 Smoke-test gateway boot with empty `~/groups/` — no crash, /sync loop runs clean; run `bun run lint && bun run build`
- [ ] T017a Scaffold `specs/062-shared-apps/manual-test.md` with the section headers of the full end-to-end Docker scenario (per plan.md §File Structure and spec.md Integration Test Checkpoint): "Preconditions", "1. Create group", "2. Join invite", "3. Share app", "4. Concurrent edit", "5. Offline + replay", "6. Crash recovery", "7. Kick + archive". Leave each section with a TODO placeholder for the eventual screenshot and expected-state text — the content is filled in by T086 at the end of Phase 9, but the skeleton lands now so that earlier phases (US1 through US6) can append findings in place as they verify their own slice against Docker

**Checkpoint**: Matrix sync hub operational, group registry reads `~/groups/`, Zod schemas locked, manual-test scaffold in place. Commit: `feat(062): Matrix sync hub + group registry + shared types`

---

## Phase 3: User Story 1 — Create, join, list, and leave groups from chat (Priority: P1) 🎯 MVP

**Goal**: A user asks the agent to "create a family group" and invite another user; the agent creates a Matrix room, scaffolds `~/groups/{slug}/`, and both members can list and leave the group. No shared state yet — just the room membership lifecycle over IPC.

**Independent Test**: From the shell chat, `create_group("Schmidt Family", ["@b:matrix-os.com"])` succeeds; `list_groups()` shows it; user B's kernel sees the invite and runs `join_group(roomId)` successfully; `leave_group("schmidt-family")` archives the dir. Verified in Docker with two gateway containers against a stub or local Synapse.

### Tests for User Story 1

- [ ] T018 [P] [US1] Write failing tests in `tests/gateway/group-routes-lifecycle.test.ts` for `POST /api/groups`, `POST /api/groups/join`, `GET /api/groups`, `GET /api/groups/:slug`, `POST /api/groups/:slug/leave` — cover Hono `bodyLimit` (256KB), bearer auth (401 generic), membership 404 on unknown caller, slug collision suffix, constructor-injected `matrixClient`/`groupRegistry`. **`POST /api/groups` MUST assert that `matrixClient.setPowerLevels` is called once, after `createRoom`, with the exact map from spec §G / spike §9.3** (`users: { [ownerHandle]: 100 }`, `users_default: 0`, `state_default: 50`, `events_default: 0`, `events["m.room.power_levels"]: 100`, `events["m.matrix_os.app_acl"]: 100`, `events["m.matrix_os.app_install"]: 50`). A missing or wrong PL map fails the test.
- [ ] T019 [P] [US1] Write failing tests in `tests/kernel/group-tools.test.ts` for `create_group`, `join_group`, `list_groups`, `leave_group` — cover `AbortSignal.timeout(10000)`, generic IPC text on HTTP errors, `GATEWAY_PORT` env default, IPC content array return shape

### Implementation for User Story 1

- [ ] T020 [US1] Implement `packages/gateway/src/group-routes.ts` exporting `createGroupRoutes({ matrixClient, groupRegistry })` returning a Hono sub-app with lifecycle routes (create/join/list/get/leave); derive slug from `m.room.canonical_alias` or generate with collision-suffix; write initial `m.matrix_os.group` state event on create. **On `POST /api/groups`, after `createRoom` but before the 201 response, MUST call `matrixClient.setPowerLevels(roomId, ...)` with the explicit map from spec §G / spike §9.3**: `users: { [ownerHandle]: 100 }`, `users_default: 0`, `state_default: 50`, `events_default: 0`, `events["m.room.power_levels"]: 100`, `events["m.matrix_os.app_acl"]: 100`, `events["m.matrix_os.app_install"]: 50`. Per-app `snapshot`/`snapshot_lease` PLs cannot be pre-registered (Matrix `power_levels.events` has no wildcards — the app slug is unknown at room creation), so the sync engine's runtime `install_pl` check against the ACL state event (spec §H) is the authoritative enforcement path for snapshot writes. The test in T018 MUST assert that `setPowerLevels` is called with this exact map when the route is invoked.
- [ ] T021 [US1] Mount `group-routes` at `/api/groups` in `packages/gateway/src/server.ts` with constructor injection of `matrixClient` + `groupRegistry`
- [ ] T022 [US1] Create `packages/kernel/src/group-tools.ts` with lifecycle tools (`create_group`, `join_group`, `list_groups`, `leave_group`), each wrapping `fetch` to `http://localhost:${GATEWAY_PORT}/api/groups/*` with `AbortSignal.timeout(10000)`; match existing `app_data` pattern; close over `db` (no `globalThis`)
- [ ] T023 [US1] Wire lifecycle tools into `createIpcServer` in `packages/kernel/src/ipc-server.ts`
- [ ] T024 [US1] Add the four lifecycle tool names — `mcp__matrix-os-ipc__create_group`, `mcp__matrix-os-ipc__join_group`, `mcp__matrix-os-ipc__list_groups`, `mcp__matrix-os-ipc__leave_group` — to `IPC_TOOL_NAMES` in `packages/kernel/src/options.ts:19`. NOTE: `set_app_acl` (T057), `share_app` (T062), and `group_data` (T079) extend this allowlist in their own phases — do not add them here
- [ ] T025 [US1] Run `bun run test tests/gateway/group-routes-lifecycle.test.ts tests/kernel/group-tools.test.ts`; verify `bun run lint && bun run build` green

**Checkpoint**: User Story 1 functional. Chat can create, join, list, and leave Matrix-backed groups with filesystem scaffolding. Commit: `feat(062): group lifecycle IPC tools`

---

## Phase 4: User Story 2 — Two replicas converge via CRDT-over-Matrix (Priority: P1)

**Goal**: Two gateway instances in the same Matrix room maintain per-app Yjs docs that converge through `m.matrix_os.app.{slug}.op` timeline events. Cold starts use lease-gated snapshot room state events. The sync engine is the core of the spec.

**Independent Test**: Two `GroupSync` instances against an in-process fake Matrix server exchange updates and converge (semantic equality via `JSON.stringify(doc.toJSON())`). Fast-check property test over 200 random mutation sequences across 3 replicas. Cold-start with 1000-event timeline + snapshot completes in <1s. Snapshot reader rejects mixed chunk sets.

### Tests for User Story 2

- [ ] T026 [US2] Write version-compat test in `tests/gateway/yjs-version-compat.test.ts` asserting `yjs` and `y-protocols` installed majors match `EXPECTED_MAJORS` and `y-protocols` peer dep on `yjs` is satisfied
- [ ] T027 [US2] Write failing tests in `tests/gateway/group-sync.test.ts` for `GroupSync`: `hydrate()` with no `state.bin`, with existing `state.bin`, corrupt file throws (caller quarantines); `applyRemoteOp(updateBase64, sender, ts)` applies, persists atomic, appends `log.jsonl`, fires `onChange`; `applyLocalMutation(fn)` encodes/sends/persists, queues on send failure; `last_sync.json` updates after `state.bin`; bad updates → `quarantine.jsonl`, no crash
- [ ] T028 [US2] Write failing property test in `tests/gateway/group-sync-conflict.property.test.ts` using `fast-check`: 3 simulated GroupSync instances, random mutation sequences, after exchange `JSON.stringify(instance.doc.toJSON())` identical across all three (200 cases minimum); NO byte-equality assertion
- [ ] T029 [US2] Add failing queue tests to `tests/gateway/group-sync.test.ts`: queue on send failure, `drainQueue()` replay in order, 10000-event cap drop-oldest with warning, exponential backoff (1s/2s/4s/8s/16s/30s), 30-minute persistent-error escalation
- [ ] T030 [US2] Write failing tests in `tests/gateway/group-sync.test.ts` for `loadLatestSnapshot(roomId, appSlug)`: enumerates `snapshot` state events, groups by `snapshot_id`, picks highest `generation`, verifies complete chunk set, rejects mixed chunk sets (test `{A,0}`, `{B,1}`, `{A,2}` falls back to previous or `null`), concatenates and base64-decodes
- [ ] T031 [US2] Write failing tests in `tests/gateway/group-sync-lease.test.ts` for `SnapshotLeaseManager.tryAcquire(roomId, appSlug)`: no lease → writes + returns lease_id (lease state_key is `{app_slug}` per spec §C, not `""`); expired lease → takes over **only after `expires_at + GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS < now`** (spec §C / spike §9.4); self-held → returns existing; other-held → returns null; inbound lease from later writer cancels in-flight snapshot writes; race property test 100 iterations. Default lease duration is now `GROUP_SYNC_SNAPSHOT_LEASE_MS = 60000` (was 600000), grace is `GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS = 10000`.
- [ ] T032 [US2] Write failing snapshot writer tests in `tests/gateway/group-sync.test.ts`: trigger at 50 ops or 5 min AND `install_pl` AND lease acquired; chunks ≤ **30 000 B base64** per chunk (≈22 500 B raw; spec §I / spike §9.2); `state_key = "{lease_id}/{chunk_index}"`; total chunks ≤ ⌈256 KB base64 / 30 KB base64⌉ = 9; oversize warning + skip; partial-write failure aborts cleanly; concurrency property test — two writers produce different `lease_id`, reader selects exactly one
- [ ] T032a [US2] Write failing tests in `tests/gateway/group-sync.test.ts` for **outbound op size cap (spec.md §I)**: a single Yjs update ≤ 32KB raw → emitted as one `m.matrix_os.app.{slug}.op` event with no `chunk_seq` (parsed by `OpEventContent` from T012/T013 with `chunk_seq` absent); an update of 33KB / 70KB / 200KB raw → split into N ≤32KB fragments, each emitted with `chunk_seq: { index, count, group_id }` in the event content and parsed through the **same `OpEventContent` schema** with the fragment envelope populated; **inbound reassembly** buffers fragments by `group_id` and applies once `count` is reached; **partial group eviction** policy — fragments older than 60s with no completion are dropped with a logged warning (and a counter incremented) so a missing fragment cannot grow the buffer indefinitely; tests cover happy path, out-of-order arrival, missing fragment timeout, and an oversize update that exceeds the maximum splittable size (configurable, default 1 MB raw → reject with `op_too_large` and surface to `onError`)
- [ ] T033 [US2] Write failing cold-start performance test in `tests/gateway/group-sync.test.ts`: 1000-event fake timeline + valid snapshot hydrates in <1s; corrupt snapshot falls back to full replay successfully
- [ ] T033a [US2] Write failing tests in `tests/gateway/group-sync-resources.test.ts` for **per-app resource caps (spec.md §Resource Management)**: `state.bin` 5 MB hard cap → on overrun, mutation rejected with `state_overflow` error and a structured warning is logged + surfaced via `onError`; `log.jsonl` 5 MB OR 30 day rotation (whichever first) — older entries pruned, newest retained, rotation is atomic; `quarantine.jsonl` 100-event drop-oldest cap with logged warning; in-memory Yjs doc registry — when total in-memory bytes for a single group exceed 100 MB, evict the least-recently-accessed app's `Y.Doc` and reload from `state.bin` on next access (test verifies eviction order and that subsequent access transparently rehydrates)

### Implementation for User Story 2

- [ ] T034 [US2] `pnpm add -F @matrix-os/gateway yjs lib0 y-protocols` with exact pinned versions (no `^`/`~`); run `pnpm install` at repo root to refresh `pnpm-lock.yaml`; commit both `packages/gateway/package.json` and lockfile together
- [ ] T035 [US2] Implement `packages/gateway/src/group-sync.ts` core: `hydrate()`, `applyRemoteOp()`, `applyLocalMutation()`, atomic `state.bin` writes (write tmp + rename), `log.jsonl` append with `fs/promises` (no sync writes in handlers), `last_sync.json` after `state.bin`, `quarantine.jsonl` on decode/apply failure
- [ ] T035a [US2] Implement **outbound op size cap + chunking** in `group-sync.ts`: before `sendCustomEvent`, compute raw byte length of the Yjs update; if ≤ 32KB emit single event; if > 32KB split into N ≤32KB fragments, emit each with `chunk_seq: { index, count, group_id }` (group_id = ULID per split) — **use the `OpEventContent` schema from T012/T013 as the source of truth for the envelope shape; never inline the field names**. If total raw > 1MB reject with `op_too_large` via `onError`. Implement **inbound fragment reassembly buffer** keyed by `group_id` with per-group TTL of 60s; on TTL expiry drop the partial group with a logged warning and increment `group_sync.fragment_timeout` counter. Parse every inbound `*.op` event through `OpEventContent.parse()` before dispatching to reassembly or apply paths
- [ ] T035b [US2] Implement **per-app resource caps** in `group-sync.ts`: `state.bin` 5MB hard cap (reject mutation on overrun, surface via `onError`); `log.jsonl` rotation policy (5MB OR 30 days, whichever first; rotation is atomic write+rename); `quarantine.jsonl` 100-event drop-oldest. All caps configurable via env (`GROUP_STATE_MAX_BYTES`, `GROUP_LOG_MAX_BYTES`, `GROUP_LOG_RETENTION_DAYS`, `GROUP_QUARANTINE_MAX`)
- [ ] T035c [US2] Implement **in-memory Yjs doc LRU eviction** at the `GroupRegistry` (or sibling `GroupDocCache`) level: track per-app doc bytes by approximating `Y.encodeStateAsUpdate(doc).length`; when total bytes for a single group exceed 100 MB (configurable via `GROUP_DOC_MAX_BYTES`), evict the least-recently-accessed app's `Y.Doc`; evicted apps transparently rehydrate from `state.bin` on next access via `GroupSync.touch()` (idempotent re-hydrate). No `globalThis`; eviction state is constructor-injected
- [ ] T036 [US2] Extend `group-sync.ts` with queue logic: `queue.jsonl` append on send failure, `drainQueue()` oldest-first, 10000-event cap with drop-oldest warning, exponential backoff with 30s cap, onError escalation after 30 minutes
- [ ] T037 [US2] Add `loadLatestSnapshot(roomId, appSlug)` to `group-sync.ts`: enumerate via `getAllRoomStateEvents`, group by `snapshot_id`, reject mixed chunk sets, concat in `chunk_index` order, base64-decode
- [ ] T038 [US2] Implement `SnapshotLeaseManager` in `group-sync.ts` (or sibling file if cleaner): lease read/write via `setRoomState(roomId, "m.matrix_os.app.{slug}.snapshot_lease", appSlug, content)` (state_key = `{app_slug}`, one lease per app); ULID via existing util or `randomUUID` fallback; self/other/expired-plus-grace branching with `GROUP_SYNC_SNAPSHOT_LEASE_MS` (default 60000) and `GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS` (default 10000) from env; inbound lease invalidation
- [ ] T039 [US2] Implement lease-gated snapshot writer in `group-sync.ts`: trigger policy, chunk ≤30 000 B **base64** per chunk (`GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64` env, default 30000), `state_key = "{lease_id}/{chunk_index}"`, per-chunk write with abort on failure, `taken_at_event_id` capture, oversize warning + skip
- [ ] T040 [US2] Wire `GroupSync` into `packages/gateway/src/server.ts` startup: after `groupRegistry.scan()` and before `syncHub.start()`, loop `for (const manifest of groupRegistry.list())`, instantiate `GroupSync`, `await sync.hydrate()`, `sync.registerHandlers(syncHub)`, `groupRegistry.attachSync(slug, sync)`; graceful-shutdown drains queue + persists
- [ ] T041 [US2] Corrupt-state handler in startup loop: catch `hydrate()` throw, quarantine `state.bin` to `state.bin.corrupt-{ts}`, instantiate fresh `GroupSync`, log structured error
- [ ] T042 [US2] Docker smoke test: two gateway containers in the same Matrix room exchange Yjs updates and converge; run `bun run lint && bun run build`

**Checkpoint**: User Story 2 functional. Two gateways converge via Matrix. Commit: `feat(062): Yjs sync engine with lease-gated snapshots`

---

## Phase 5: User Story 3 — Iframe app reads and writes shared state live (Priority: P1)

**Goal**: An iframe opened from a group context uses `MatrixOS.shared.get/set/doc/onChange` to read and write a shared Y.Map. Edits in one browser appear in another within ~1 second. The iframe runs a mirror Y.Doc; the gateway holds the authoritative copy.

**Independent Test**: Two browser tabs in different Docker containers open the same group app via `?group={slug}`. Tab A calls `MatrixOS.shared.set("note1", "hello")`. Tab B's `onChange` fires with the same value. Tab B's `MatrixOS.shared.get("note1")` returns `"hello"`. Verified via React hook rerender in a Vitest + happy-dom harness.

### Tests for User Story 3

- [ ] T043 [US3] Write failing tests in `tests/gateway/group-ws.test.ts` for WS upgrade at `/ws/groups/:slug/:app`: bearer + membership + ACL `read_pl` on upgrade; Yjs `syncStep1`/`syncStep2`/`update` handshake; per-connection state (no shared buffers); ACL downgrade mid-connection closes socket with code 4403
- [ ] T044 [US3] Write failing tests in `tests/shell/os-bridge.test.ts` for `MatrixOS.shared.get/set/delete/list/onChange` against a fake gateway WS that speaks Yjs sync protocol; mirror `Y.Doc` reconnect re-syncs; `MatrixOS.shared.doc()` returns the mirror (not authoritative); `MatrixOS.group` is `null` outside group context, populated when query param `?group={slug}` is present; `MatrixOS.group.members` returns `[]` until US6; **`MatrixOS.shared.onError(cb)` (spec.md §J)** fires with the coarse-grained codes `"sync_failed"`, `"acl_denied"`, `"offline"`, `"op_too_large"`, `"state_overflow"` — never with internal/Matrix error text. Tests cover each code path (gateway 5xx → `sync_failed`; ACL denial → `acl_denied`; WS disconnect → `offline`; outbound op > 1MB → `op_too_large`; `state.bin` cap hit → `state_overflow`)
- [ ] T045 [US3] Write failing tests in `tests/shell/useSharedDoc.test.tsx` for `useSharedDoc(name)` returning mirror `Y.Doc` and rerendering on remote updates; `useSharedKey(key)` reading/writing a `Y.Map("kv")` entry; both hooks clean up subscriptions on unmount

### Implementation for User Story 3

- [ ] T046 [US3] `pnpm add -F shell yjs lib0 y-protocols` pinned to the **exact same versions** as `packages/gateway/package.json`; run `pnpm install` at repo root; commit lockfile in the same commit
- [ ] T047 [US3] Implement `packages/gateway/src/group-ws.ts` using Hono WebSocket: auth + ACL check on upgrade, `y-protocols/sync` `syncStep1`→`syncStep2`→`update` message loop, bridge `GroupSync.onChange` fan-out to connected sockets for `(group_slug, app_slug)`, close with 4403 on ACL downgrade
- [ ] T048 [US3] Mount `/ws/groups/:slug/:app` in `packages/gateway/src/server.ts` with `groupRegistry` injection
- [ ] T049 [US3] Create `shell/src/lib/group-bridge.ts` with WebSocket client + mirror `Y.Doc` lifecycle; implement `MatrixOS.shared.onError(cb)` listener registry mapping internal failure modes to the coarse codes `sync_failed | acl_denied | offline | op_too_large | state_overflow` (no internal error text leaks across the iframe boundary); add header comment: "Yjs version MUST match `packages/gateway/package.json`. Mismatch corrupts binary updates."
- [ ] T050 [US3] Extend `shell/src/lib/os-bridge.ts` postMessage handler with `shared:*` and `group:*` action types delegating to `group-bridge.ts`; populate `MatrixOS.group` from `?group={slug}` query param
- [ ] T051 [US3] [P] Implement `shell/src/hooks/useSharedDoc.ts` returning the mirror `Y.Doc` and subscribing to updates
- [ ] T052 [US3] [P] Implement `shell/src/hooks/useSharedKey.ts` as `Y.Map("kv")` entry hook
- [ ] T052a [US3] [P] Implement `shell/src/components/GroupSwitcher.tsx` (per plan.md File Structure) — app-tray dropdown listing the user's groups from `GET /api/groups`, switching context updates the URL `?group={slug}` query param so iframes pick up the new context on next load; renders a "Personal" entry for `MatrixOS.group === null`; covered by a Vitest + happy-dom test that mocks the groups list and asserts URL transitions
- [ ] T053 [US3] Run `bun run test`, `bun run lint`, `bun run build`; manual two-tab Docker smoke test

**Checkpoint**: User Story 3 functional. An iframe app sees live shared state in the browser. Commit: `feat(062): WS bridge + shell mirror Y.Doc + React hooks`

---

## Phase 6: User Story 4 — Per-app ACL enforcement (Priority: P2)

**Goal**: `m.matrix_os.app_acl` state events gate reads and writes. Members below `write_pl` cannot mutate shared state; members below `read_pl` cannot open the WebSocket. An admin can tighten or loosen ACL via the kernel.

**Independent Test**: With an app ACL of `write_pl=50`, a power-0 user's `MatrixOS.shared.set` call is rejected with `acl_denied`. Setting `write_pl=0` via `set_app_acl` tool then allows the same call to succeed. Existing in-flight ops below the new `write_pl` are dropped on receipt by other clients.

### Tests for User Story 4

- [ ] T054 [US4] Write failing tests in `tests/gateway/group-acl.test.ts`: startup fetch of `m.matrix_os.app_acl` per installed app, cache to `~/groups/{slug}/acl/{app}.json`, inbound op drop on denied sender, outbound op rejection on denied self, cache refresh on ACL state event change before processing next op
- [ ] T055 [US4] Add failing test to `tests/kernel/group-tools.test.ts`: `set_app_acl("schmidt-family", "notes", { write_pl: 50 })` calls `setRoomState` with new ACL; 403 when caller lacks `install_pl`

### Implementation for User Story 4

- [ ] T056 [US4] Extend `packages/gateway/src/group-sync.ts` with ACL read/write/cache: startup fetch via `matrixClient.getRoomState`, `acl/{app}.json` cache, power-level check on inbound before apply, power-level check on outbound before send, refresh on inbound `m.matrix_os.app_acl` event
- [ ] T057 [US4] Add `set_app_acl` tool to `packages/kernel/src/group-tools.ts` calling gateway loopback; wire via `ipc-server.ts`; add `mcp__matrix-os-ipc__set_app_acl` to `IPC_TOOL_NAMES` in `packages/kernel/src/options.ts:19`
- [ ] T058 [US4] Add a gateway route for ACL update (`POST /api/groups/:slug/apps/:app/acl`) to `packages/gateway/src/group-routes.ts`; enforce `install_pl` server-side; inject into existing `createGroupRoutes` factory
- [ ] T058a [US4] Implement **ACL UI panel (spec.md Phase 6 / `Phasing` section)** in `shell/src/components/AppAclPanel.tsx` — surfaces in the existing app settings panel when the app is opened from a group context; reads ACL via `GET /api/groups/:slug` (extend to include per-app ACL) or a new `GET /api/groups/:slug/apps/:app/acl`; lets a member with `install_pl` toggle `read_pl` / `write_pl` / `install_pl` and pick a policy preset (`open` / `moderated` / `owner_only`); writes via the route from T058; disabled with explanatory tooltip for members below `install_pl`. Vitest + happy-dom test covers the disabled-state branch and the optimistic-update path
- [ ] T059 [US4] Run tests, lint, build

**Checkpoint**: User Story 4 functional. Per-app ACL enforced on both inbound and outbound paths. Commit: `feat(062): per-app ACL via Matrix room state`

---

## Phase 7: User Story 5 — Share an app across a group (Priority: P2)

**Goal**: Owner runs `share_app("notes", "schmidt-family")`. The app code is copied into `~/groups/{slug}/apps/notes/`, a default ACL state event is written, and an `m.matrix_os.app_install` timeline event propagates so other members' kernels auto-clone the app. The receiving user sees an accept/decline prompt.

**Independent Test**: From two gateway containers joined to the same room, container A calls `share_app("notes", "test-fam")`. Container B's kernel surfaces the install prompt, accepts, and the app appears under `~/groups/test-fam/apps/notes/` with `GroupSync` running for it. User B can now open the app from the shell and see shared state.

### Tests for User Story 5

- [ ] T060 [US5] Write failing test in `tests/kernel/group-tools.test.ts`: `share_app("notes", "schmidt-family")` reuses `installApp` to copy `~/apps/notes` → `~/groups/schmidt-family/apps/notes`, writes initial `m.matrix_os.app_acl` default policy, sends `m.matrix_os.app_install` timeline event, refuses when caller lacks `install_pl`
- [ ] T061 [US5] Write failing test in `tests/gateway/group-sync.test.ts`: on inbound `m.matrix_os.app_install`, GroupSync fetches app code (via existing upload URL in event content), clones into `~/groups/{slug}/apps/{app}/`, spawns a new `GroupSync` slot for the app, surfaces a notification; user-decline path leaves filesystem untouched

### Implementation for User Story 5

- [ ] T062 [US5] Add `share_app` tool to `packages/kernel/src/group-tools.ts` calling a new gateway route `POST /api/groups/:slug/share-app`; reuse `app-upload.ts` tarball transport; wire via `ipc-server.ts`; add `mcp__matrix-os-ipc__share_app` to `IPC_TOOL_NAMES` in `packages/kernel/src/options.ts:19`
- [ ] T063 [US5] Implement `POST /api/groups/:slug/share-app` in `packages/gateway/src/group-routes.ts`: enforce `install_pl`, call `installApp`, write `m.matrix_os.app_acl` with default policy, send `m.matrix_os.app_install` via `matrixClient.sendCustomEvent`
- [ ] T064 [US5] Add inbound `m.matrix_os.app_install` handler in `packages/gateway/src/group-sync.ts`: register via `syncHub.registerEventHandler`, fetch app code from URL in event content with `AbortSignal.timeout(30000)`, clone into group dir, spawn new per-app `GroupSync` slot, surface notification via existing `notifyShellHook`
- [ ] T065 [US5] Run tests, lint, build

**Checkpoint**: User Story 5 functional. End-to-end app share flow across two containers. Commit: `feat(062): share_app + auto-clone over Matrix events`

---

## Phase 8: User Story 6 — Observed members, presence, and cross-channel access (Priority: P3)

**Goal**: The shell shows a live member list and presence state for any group. Agents from any channel (Telegram, Discord, voice) can read and write shared state through the `group_data` kernel tool. v1 is observe-only for presence — the gateway never publishes `m.presence`.

**Independent Test**: Open the group app in the shell; member list and online/offline state render from `GET /api/groups/:slug/members` and `/presence` routes. A Telegram-channel agent calls `group_data({ action: "write", group_slug, app_slug, key: "note1", value: "hi" })` and the browser iframe's `onChange` fires. A 257KB value is rejected by `GroupDataValueSchema`; a 513KB value is rejected by the 512KB Hono `bodyLimit`.

### Tests for User Story 6

- [ ] T066 [US6] [P] Write failing tests in `tests/gateway/group-members.test.ts`: `GET /api/groups/:slug/members` derives from `m.room.member` + `m.room.power_levels`, maps role (owner=100, editor=50, viewer=0, intermediate bucketed), updates `members.cache.json` on every member event, broadcasts `members_changed` to WS subscribers of `(group_slug, *)`, caps cache at 1000 entries
- [ ] T067 [US6] [P] Write failing tests in `tests/gateway/group-presence.test.ts`: `GET /api/groups/:slug/presence` returns `{ "@user:matrix-os.com": { status, last_active_ago } }` from `m.presence` events scoped to group members; `presence_changed` WS event fires; members not in the group filtered out; **negative tests**: no `POST /presence` route, no `set_group_presence` IPC tool
- [ ] T068 [US6] [P] Write failing tests in `tests/shell/useGroupMembers.test.tsx`: hook returns `{ members, presenceByHandle }`, rerenders on either changing
- [ ] T068a [US6] [P] Write failing tests in `tests/shell/os-bridge-presence.test.ts` for **`MatrixOS.group.onPresence(callback)` (spec.md §F)**: callback fires with `{ handle, status, last_active_ago }` shape on every `presence_changed` WS event; multiple subscribers fan out; unsubscribe via returned disposer; callback never fires for handles outside the current group; **`MatrixOS.group.members`** returns the list populated from the `members_changed` WS event (no longer `[]` as in US3 placeholder)
- [ ] T069 [US6] Write failing tests in `tests/gateway/group-routes-data.test.ts` for `POST /api/groups/:slug/data`: body validated by `GroupDataRequestSchema`, `read`/`write`/`list` actions, bearer + membership, **Hono `bodyLimit` 512KB** (so schema's 256KB cap fires first on reasonable oversize), generic 400 on schema failure (no Zod leakage), write funnels through `applyLocalMutation` so ACL enforcement applies; edge tests for 257KB (schema reject) and 513KB (bodyLimit reject)
- [ ] T070 [US6] Write failing tests in `tests/kernel/group-tools.test.ts` for `group_data({ action, group_slug, app_slug, key?, value? })`: POST with `AbortSignal.timeout(10000)`, generic IPC text on HTTP errors, returns IPC content array

### Implementation for User Story 6

- [ ] T071 [US6] Add `m.room.member` handler to `packages/gateway/src/group-sync.ts` — register via `syncHub.registerEventHandler`, update `members.cache.json` atomically, enforce 1000-entry cap; expose member list getter for routes
- [ ] T072 [US6] Add `GET /api/groups/:slug/members` to `packages/gateway/src/group-routes.ts` — derive fresh from matrix state when online, use cache as offline fallback
- [ ] T073 [US6] Add `members_changed` WS broadcast to `packages/gateway/src/group-ws.ts` — fans out to all `(group_slug, *)` subscribers on member list changes
- [ ] T074 [US6] Add `m.presence` global handler via `syncHub.registerGlobalEventHandler` — filter to group members per `GroupSync` instance, cache in-memory only
- [ ] T075 [US6] Add `GET /api/groups/:slug/presence` to `packages/gateway/src/group-routes.ts` — returns `m.presence` shape scoped to group members
- [ ] T076 [US6] Add `presence_changed` WS broadcast to `packages/gateway/src/group-ws.ts`
- [ ] T077 [US6] [P] Implement `shell/src/hooks/useGroupMembers.ts` — exposes `{ members, presenceByHandle }` with re-render on either
- [ ] T077a [US6] Extend `shell/src/lib/group-bridge.ts` to subscribe to `members_changed` and `presence_changed` WS events; populate `MatrixOS.group.members` (replacing the US3 `[]` placeholder) and dispatch to `MatrixOS.group.onPresence(callback)` listeners. No new file — modifies the bridge created in T049
- [ ] T078 [US6] Add `POST /api/groups/:slug/data` to `packages/gateway/src/group-routes.ts` — Hono `bodyLimit(512KB)`, parse via `GroupDataRequestSchema`, funnel writes through `GroupSync.applyLocalMutation(doc => doc.getMap("kv").set(key, value))`
- [ ] T079 [US6] Add `group_data` tool to `packages/kernel/src/group-tools.ts` — POST to data route with `AbortSignal.timeout(10000)`; wire via `ipc-server.ts`; add `mcp__matrix-os-ipc__group_data` to `IPC_TOOL_NAMES` in `packages/kernel/src/options.ts:19` (T024 only added the four lifecycle entries; this completes the allowlist)
- [ ] T080 [US6] Run tests, lint, build

**Checkpoint**: User Story 6 functional. Members + presence observed; agents on any channel read/write shared state with ACL enforcement. Commit: `feat(062): observed members + presence + group_data cross-channel tool`

---

## Phase 9: User Story 7 — End-to-end shared notes demo (Priority: P3)

**Goal**: Migrate the default notes app to optional group mode. Two browser contexts (User A, User B) sign in, create a group, invite each other, share the notes app, and collaboratively edit in real time. This is the final proof that everything wired correctly, captured as a Playwright e2e with screenshots.

**Independent Test**: `bun run test:e2e tests/e2e/shared-app.spec.ts` passes. Playwright screenshots captured at each step. Manual Docker run of the same flow succeeds with timings ≤ spec targets (p95 latency <1s, cold start <5s).

### Tests for User Story 7

- [ ] T081 [US7] Write Playwright e2e in `tests/e2e/shared-app.spec.ts`: two browser contexts A/B signed in via Clerk test users, A creates group + invites B, B accepts, A shares notes, B accepts install prompt, A creates a note (B sees it within 2s), B edits note (A sees edit), A goes offline and makes 5 more edits, A reconnects and all 5 replay

### Implementation for User Story 7

- [ ] T082 [US7] Pick demo app (recommend `~/apps/notes`) and update its `matrix.json` with `shared: true`
- [ ] T083 [US7] Refactor notes app data layer to read from `MatrixOS.shared.doc().getMap("notes")` when `MatrixOS.group !== null`, fall back to `MatrixOS.db.*` when personal
- [ ] T084 [US7] Add "Share with group" button in notes app UI — lists user's groups, calls `share_app` via chat agent or direct IPC trigger
- [ ] T085 [US7] Capture Playwright screenshots per step into `tests/e2e/screenshots/shared-app/` per `feedback_playwright_screenshots.md`
- [ ] T086 [US7] Update `specs/062-shared-apps/manual-test.md` with the **full end-to-end scenario** — the file was scaffolded as a skeleton in Phase 2 (T017a) per plan.md §File Structure and spec.md Integration Test Checkpoint. This task replaces the skeleton with the complete Docker flow: two-account signup, create group, invite, share notes, concurrent edit, offline + replay, crash recovery, kick + archive — each step has expected UI state and screenshot references captured from Playwright output in T085
- [ ] T087 [US7] Run `bun run test:e2e tests/e2e/shared-app.spec.ts`; verify lint + build

**Checkpoint**: End-to-end demo works in Docker. User Story 7 functional. Commit: `feat(062): shared notes demo + Playwright e2e + manual test doc`

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Quality gates, coverage verification, doc updates, PR preparation.

- [ ] T088 [P] Run `/review-spec` skill against `specs/062-shared-apps/spec.md` and fix any gaps
- [ ] T089 [P] Run `superpowers:requesting-code-review` on the implementation
- [ ] T090 Grep for `globalThis` in new files — zero hits required
- [ ] T091 Grep for `appendFileSync` / `writeFileSync` in handlers — zero hits required
- [ ] T092 Grep for `fetch(` in new files and verify every call has `AbortSignal.timeout(...)`
- [ ] T093 Verify Hono `bodyLimit` middleware on every mutating route in `packages/gateway/src/group-routes.ts` and `group-ws.ts`
- [ ] T094 Verify every route input is parsed through a Zod schema from `group-types.ts` before use
- [ ] T095 Run `bun run test --coverage` — require `group-sync.ts`, `group-registry.ts`, `group-tools.ts`, `matrix-sync-hub.ts` all ≥99%
- [ ] T096 Add tests for any uncovered branches surfaced by T095
- [ ] T097 [P] Update `CLAUDE.md` Active Technologies with Yjs + lib0 + y-protocols entry
- [ ] T098 [P] Update `CLAUDE.md` Recent Changes with 062 entry
- [ ] T099 Run `/update-docs` skill per CLAUDE.md "After major features" rule
- [ ] T100 Manual Docker verification (per `feedback_test_before_push.md`): full spec 062 Integration Test Checkpoint scenarios from spec.md — user must approve before PR push
- [ ] T101 Open PR with title `feat(062): shared apps via CRDT-over-Matrix`; body links spec, plan, spike report; attach a gif/video of two browsers editing the same note live

**Final checkpoint**: Spec complete, merged, demo recorded.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No code dependencies. **BLOCKING**: spike report go decision must commit before Phase 2.
- **Foundational (Phase 2)**: Depends on Phase 1 go decision. Blocks ALL user stories.
- **US1 (Phase 3)**: Depends on Phase 2 (needs `matrix-client.ts`, `MatrixSyncHub`, `GroupRegistry`, `group-types.ts`)
- **US2 (Phase 4)**: Depends on Phase 2 (needs same infra) + Phase 3 T022 (wiring patterns, but not strictly required for the engine itself)
- **US3 (Phase 5)**: Depends on US2 (needs `GroupSync` running per group)
- **US4 (Phase 6)**: Depends on US2 (ACL gates the sync engine) + US3 (ACL gates WS handshake)
- **US5 (Phase 7)**: Depends on US4 (default ACL written on share); relies on US2/US3 for the sync + bridge used after clone
- **US6 (Phase 8)**: Depends on US4 (cross-channel writes need ACL enforcement)
- **US7 (Phase 9)**: Depends on all prior user stories (this is the full-flow demo)
- **Polish (Phase 10)**: Depends on all user stories being in place

### User Story Dependencies (diagram)

```
Foundational (Phase 2)
        ↓
       US1 ──────────────┐
        ↓                │
       US2               │
        ↓                │
       US3 ──────────────┤
        ↓                │
       US4               │
        ↓                │
       US5               │
        ↓                │
       US6               │
        ↓                │
       US7 ←─────────────┘
        ↓
     Polish
```

US1 is the only story that can proceed without a working CRDT engine — it exercises only the Matrix sync hub + group registry + lifecycle routes. Every other story chains on the sync engine.

### Within Each User Story

- Tests written **first** and **failing** before implementation (TDD is non-negotiable)
- Schemas/types before routes
- Routes before kernel tools that call them
- Server-side WS/endpoint before shell client
- `bun run lint && bun run build` after every task, not just at the end

### Parallel Opportunities

- **Phase 1**: T002 and T003 are independent scripts → `[P]`
- **Phase 2**: T012/T013 (group-types), T014/T015 (group-registry) target different files from `matrix-client.ts` and `matrix-sync-hub.ts` → `[P]` after T006–T011 complete
- **Phase 3**: T018 and T019 target different test files → `[P]`
- **Phase 5**: T051, T052 (`useSharedDoc.ts` / `useSharedKey.ts`), T052a (`GroupSwitcher.tsx`) target different shell files → `[P]`
- **Phase 8**: T066, T067, T068, T068a test files are independent → `[P]`; T077 (`useGroupMembers.ts`) → `[P]`
- **Phase 10**: T088, T089, T097, T098 touch different files or are read-only → `[P]`

Inside Phases 4, 6, 7 most tasks modify `group-sync.ts` sequentially, so they do not parallelize safely.

### Parallel Example: Phase 2 Foundational

```bash
# After matrix-client.ts and matrix-sync-hub.ts land (T006–T011 sequential):
Task: "Write failing Zod tests in tests/gateway/group-types.test.ts"
Task: "Write failing tests in tests/gateway/group-registry.test.ts"

# Then implementations in parallel:
Task: "Implement packages/gateway/src/group-types.ts"
Task: "Implement packages/gateway/src/group-registry.ts"
```

### Parallel Example: Phase 8 Member + Presence Tests

```bash
# Three independent test files can be written in parallel:
Task: "Write failing tests in tests/gateway/group-members.test.ts"
Task: "Write failing tests in tests/gateway/group-presence.test.ts"
Task: "Write failing tests in tests/shell/useGroupMembers.test.tsx"
```

---

## Implementation Strategy

### MVP Scope

**MVP = Phases 1 + 2 + 3 + 4 + 5** (US1 + US2 + US3):

1. Spike (Phase 1) — proves the architecture
2. Foundational (Phase 2) — Matrix sync hub + registry + schemas
3. US1 (Phase 3) — create/join/list/leave groups
4. US2 (Phase 4) — CRDT engine converges two replicas
5. US3 (Phase 5) — iframe app reads/writes shared state live

At this point a user can create a group, invite a member, and collaboratively edit a shared Y.Map from two browsers. **That is the smallest useful deliverable** and satisfies the spec's headline user need.

### Incremental Delivery After MVP

1. **MVP (P1)** → Demo to user, ship if reliability holds
2. **+ US4 (P2) ACL** → Gate writes so non-editors can't corrupt state → Ship
3. **+ US5 (P2) share_app** → Replace manual filesystem copies with in-chat sharing → Ship
4. **+ US6 (P3) members/presence/group_data** → Cross-channel agents + observability → Ship
5. **+ US7 (P3) demo + e2e** → Playwright regression + migrated notes app → Merge

### Parallel Team Strategy

This spec is mostly sequential because US2 → US3 → US4 chains on the same `group-sync.ts` file. Parallelization opportunities:

- **Phase 2**: `matrix-sync-hub.ts`, `group-types.ts`, `group-registry.ts` split across three engineers after T006/T007 land
- **Phase 8**: members (T066, T071–T073) vs presence (T067, T074–T076) vs cross-channel (T069/T070, T078/T079) split across three engineers
- **Phase 9 vs Phase 10**: e2e test authoring (T081) can run in parallel with Phase 10 quality-gate sweeps

Do NOT parallelize inside Phase 4 — `group-sync.ts` is a single-writer file and TDD cadence requires each test to be green before the next lands.

---

## Independent Test Criteria per User Story

| US | Delivers | How to verify independently |
|---|---|---|
| **US1** | Group lifecycle (create/join/list/leave) | Docker: two containers, create group in A, join in B, list shows one entry, leave archives dir |
| **US2** | Two replicas converge via CRDT | Vitest: fake Matrix server, two GroupSync, converge semantically; fast-check 200 runs; cold start <1s |
| **US3** | Iframe app sees live shared state | Two browser tabs (same or different containers), `shared.set` in A fires `onChange` in B within ~1s |
| **US4** | ACL blocks denied writes | With `write_pl=50`, power-0 user's `shared.set` returns `acl_denied`; lower ACL → same call succeeds |
| **US5** | Share app auto-clones for member | A `share_app("notes", g)`; B's container auto-clones and runs GroupSync; B opens app and sees shared state |
| **US6** | Cross-channel + observability | Telegram agent `group_data` writes, iframe `onChange` fires; shell shows member list + presence |
| **US7** | Full demo recorded | `bun run test:e2e tests/e2e/shared-app.spec.ts` green; manual Docker run matches `manual-test.md` |

---

## Phase 7b: Shell UI — Group Management (Priority: P2)

**Goal**: Complete the shell-side UI so users can manage groups, members, and shared apps entirely from the browser. The backend routes already exist (group-routes.ts); this phase wires them to visible UI components.

**Depends on**: Phase 3 (group lifecycle routes), Phase 5 (GroupSwitcher done), Phase 6 (ACL for power-level checks in members/share)

**Independent Test**: From the browser at `http://localhost:3001`, alice can: create a group (GroupSwitcher), see members (MembersPanel), invite bob, share the notes app (ShareAppDialog), and see shared apps listed (GroupAppList). Bob at `http://localhost:3002` joins and sees the same shared apps.

### Gateway: Invite + App List routes

- [ ] T101 [US7b] Write failing tests in `tests/gateway/group-routes-invite.test.ts` for `POST /api/groups/:slug/invite` — wraps `matrixClient.inviteToRoom(roomId, userId)`; requires auth + group membership + power level >= invite PL; validates handle format; returns 200 on success, 403 if caller lacks PL, 404 if group unknown, 400 if invalid handle
- [ ] T102 [US7b] Implement `POST /api/groups/:slug/invite` in `packages/gateway/src/group-routes.ts`; wire `matrixClient.inviteToRoom`; check caller PL >= `invite` PL from room power levels (default 0 for `private_chat`)
- [ ] T103 [P] [US7b] Write failing tests in `tests/gateway/group-routes-apps.test.ts` for `GET /api/groups/:slug/apps` — returns list of app slugs under `~/groups/:slug/apps/` with each app's name from its manifest; empty array if no apps; 404 if group unknown; 401 without auth
- [ ] T104 [P] [US7b] Implement `GET /api/groups/:slug/apps` in `packages/gateway/src/group-routes.ts`; reads `{homePath}/groups/{slug}/apps/` directory, returns `{ apps: [{ slug, name }] }`

### Shell: MembersPanel

- [ ] T105 [US7b] Create `shell/src/components/MembersPanel.tsx` — slide-out panel triggered by a "Members" button in the GroupSwitcher dropdown (or a dedicated button when a group is active). Fetches `GET /api/groups/:slug/members` from gateway. Shows each member with role badge (owner/editor/viewer) and membership status (joined/invited). Owner sees "Invite" form at top and "Remove" button per member.
- [ ] T106 [US7b] Write Vitest + jsdom test in `tests/shell/MembersPanel.test.tsx` — mock fetch, verify renders member list, invite form submits to correct endpoint, remove button calls leave/kick endpoint, empty state shown when no members beyond self

### Shell: ShareAppDialog

- [ ] T107 [US7b] Create `shell/src/components/ShareAppDialog.tsx` — modal dialog triggered from app window header. Lists user's groups from `GET /api/groups`. On select, calls `POST /api/groups/:slug/share-app` with `{ app_slug }`. Shows loading/success/error states. Disabled if app is already shared to that group.
- [ ] T108 [US7b] Wire ShareAppDialog trigger into app window header in `shell/src/components/AppWindow.tsx` (or equivalent) — "Share" icon button, only visible when viewing a personal app (not already in a group context)
- [ ] T109 [US7b] Write Vitest + jsdom test in `tests/shell/ShareAppDialog.test.tsx` — mock fetch, verify group list renders, selection triggers POST, success closes dialog, error shown on failure

### Shell: GroupAppList

- [ ] T110 [US7b] Create `shell/src/components/GroupAppList.tsx` — grid/list of shared apps for the active group. Fetches `GET /api/groups/:slug/apps`. Each app tile shows name + icon, clicking opens the app in group context (URL `?group=slug&app=appSlug`). Empty state: "No shared apps yet — share one from your personal workspace."
- [ ] T111 [US7b] Wire GroupAppList into the Desktop component — when `activeGroupSlug` is set (from GroupSwitcher / URL param), show GroupAppList overlay or panel alongside the personal dock
- [ ] T112 [US7b] Write Vitest + jsdom test in `tests/shell/GroupAppList.test.tsx` — mock fetch, verify app tiles render, click navigates with correct query params, empty state shown

### Shell: WebSocket Bridge (CRDT live sync)

- [ ] T113 [US7b] Create `shell/src/lib/group-bridge.ts` — WebSocket client connecting to `/ws/groups/:slug/:app` on gateway. Maintains a mirror `Y.Doc` synced via `y-protocols/sync` messages. Exposes `applyLocal(update)` and `onChange(callback)` for the iframe bridge. Reconnects on close with exponential backoff. Closes cleanly on group/app switch.
- [ ] T114 [US7b] Extend `shell/src/lib/os-bridge.ts` postMessage handler with `shared:get`, `shared:set`, `shared:delete`, `shared:list`, `shared:onChange` action types delegating to `group-bridge.ts`; populate `MatrixOS.group` context from URL `?group=` param
- [ ] T115 [US7b] Write Vitest test in `tests/shell/group-bridge.test.ts` — mock WebSocket, verify sync handshake, local mutations forwarded, remote updates trigger onChange, reconnect on close

### Integration

- [ ] T116 [US7b] Docker smoke test: start `bun run docker:multi`, alice creates group via GroupSwitcher, opens MembersPanel and invites bob, shares notes app via ShareAppDialog, bob joins and sees shared app in GroupAppList. Capture steps in `specs/062-shared-apps/manual-test.md` sections 1-3.
- [ ] T117 [US7b] Run `bun run test` — all new tests green, no regressions in existing tests

**Checkpoint**: Full group management UI operational. Users can create groups, invite members, share apps, and see shared apps — all from the browser. Commit: `feat(062): shell UI for group management`

---

## Format Validation

- Every task starts with `- [ ]`
- Every task has a sequential ID `T0NN`
- Every user story task carries `[US1]`–`[US7]`
- Setup, Foundational, and Polish tasks have no `[Story]` label
- `[P]` appears only on tasks that target a different file from other same-phase tasks
- Every task names the exact file path to create or modify

**Total**: 130 tasks across 11 phases (5 spike, 13 foundational, 8 US1, 22 US2, 12 US3, 7 US4, 6 US5, 17 US6, 17 US7b shell UI, 7 US7, 14 polish). The 12 letter-suffixed IDs (T017a, T032a, T033a, T035a–c, T052a, T058a, T068a, T077a) were inserted post-review to close gaps from the spec audit; they do not break existing T-number references. T101–T117 were added for the shell UI phase.

**Suggested MVP**: Phases 1–5 = 59 tasks (T001–T053 plus the 6 inserted sub-tasks T017a, T032a, T033a, T035a, T035b, T035c, T052a). At that point you have working CRDT-over-Matrix for two browsers, with the 32KB op cap, per-app resource caps, and a manual-test scaffold in place for recording Docker verification findings from day one.

**Suggested browser-testable milestone**: Phases 1–5 + Phase 7b (T101–T117) = 76 tasks. This adds the shell UI so users can test the full group flow from the browser without curl commands.
