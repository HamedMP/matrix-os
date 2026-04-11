# Shared Apps Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple Matrix OS users to share a single app instance with live, conflict-free state synchronization. Builder ships an app once, group members each get a live local replica that converges via CRDT-over-Matrix.

**Architecture:** Matrix room = group. Yjs CRDT doc per app per group. State stored as `m.matrix_os.app.{slug}.op` timeline events (mutation log) + `m.matrix_os.app.{slug}.snapshot` room state events (cold-start optimization). Local replica in `~/groups/{slug}/data/{app}/state.bin`. Sync engine in gateway, IPC tools in kernel, bridge API for iframe apps.

**Tech Stack:** Yjs (CRDT engine), lib0 (encoding), Matrix `/sync` long-poll, existing Hono gateway, existing IPC server, Vitest, Playwright.

**Testing Strategy:** Unit tests use in-process Yjs property tests + a stubbed Matrix client (msw or hand-written fake). Integration tests run against a local Synapse container in `docker-compose.dev.yml`. End-to-end tests use Playwright with two browser contexts to simulate two real users.

**Pre-flight:** Phase 0 spike is BLOCKING. Do not start Phase 1 until spike report exists at `specs/062-shared-apps/spike.md` with measured numbers and a written go decision.

---

## File Structure

```
specs/062-shared-apps/
  spec.md                                  -- DONE
  plan.md                                  -- DONE (this file)
  spike.md                                 -- NEW: Phase 0 output
  manual-test.md                           -- NEW: created in Phase 2

packages/gateway/src/
  matrix-client.ts                         -- MODIFY: add sync(), createRoom, inviteToRoom, kickFromRoom, leaveRoom, getRoomMembers, getPowerLevels, setPowerLevels, getRoomState, getAllRoomStateEvents, setRoomState (raw HTTP only — dispatch lives in MatrixSyncHub)
  matrix-sync-hub.ts                       -- NEW: single account-wide /sync long-poll, fan-out to handlers
  group-registry.ts                        -- NEW: scan ~/groups/, manifest IO
  group-sync.ts                            -- NEW: per-group Yjs engine, registers handlers with MatrixSyncHub (NO own /sync loop)
  group-routes.ts                          -- NEW (created in Chunk 2; expanded in Chunks 5–8 — single source of truth for /api/groups/*)
  group-ws.ts                              -- NEW: WebSocket /ws/groups/{slug}/{app} (Yjs mirror sync)
  group-types.ts                           -- NEW: Zod schemas for group manifests, ACL, op events, snapshot, lease
  server.ts                                -- MODIFY: wire MatrixSyncHub + GroupRegistry + GroupSync at startup

packages/kernel/src/
  options.ts                               -- MODIFY: add new tool names to IPC_TOOL_NAMES allowlist (line 19)
  ipc-server.ts                            -- MODIFY: register create_group, join_group, list_groups, leave_group, share_app, group_data, set_app_acl
  group-tools.ts                           -- NEW: tool implementations; each tool calls gateway HTTP loopback (matches existing app_data pattern)

shell/src/lib/
  os-bridge.ts                             -- MODIFY: add MatrixOS.shared, MatrixOS.group postMessage actions
  group-bridge.ts                          -- NEW: WebSocket client to /ws/groups/*, mirror Y.Doc lifecycle

shell/src/hooks/
  useSharedDoc.ts                          -- NEW: React hook returning a mirror Y.Doc
  useSharedKey.ts                          -- NEW: React hook for Y.Map key shortcut
  useGroupMembers.ts                       -- NEW (Chunk 8): observed members + presence (read-only in v1)

shell/src/components/
  GroupSwitcher.tsx                        -- NEW: app tray group switcher

shell/package.json                         -- MODIFY: add yjs + lib0 deps for the mirror Y.Doc (Chunk 5)
packages/gateway/package.json              -- MODIFY: add yjs + lib0 deps for the authoritative Y.Doc (Chunk 3)

tests/
  gateway/matrix-client-extensions.test.ts -- NEW: room lifecycle, room state, members, power levels, /sync
  gateway/group-registry.test.ts           -- NEW: scan, hydrate, atomic writes
  gateway/group-sync.test.ts               -- NEW: Yjs merge, replay, queue, snapshot
  gateway/group-sync-conflict.property.test.ts  -- NEW: fast-check property test
  gateway/group-routes.test.ts             -- NEW: HTTP auth + ACL enforcement
  kernel/group-tools.test.ts               -- NEW: IPC tool happy paths + ACL denials
  e2e/shared-app.spec.ts                   -- NEW: Playwright two-user flow
```

---

## Chunk 0: Spike (BLOCKING — do this first)

### Task 0.1: Two-account Matrix round-trip measurement

**Files:**
- Create: `specs/062-shared-apps/spike.md`
- Create (throwaway): `scripts/spike-matrix-roundtrip.ts`

- [ ] **Step 1:** Provision two test accounts on the existing matrix-os.com Synapse (or local Synapse via docker compose). Document homeserver URL + access tokens in `.env.spike` (gitignored).
- [ ] **Step 2:** Write a 100-line script that creates a room from account A, invites B, has B join, then sends 100 `m.matrix_os.test.op` custom events from A and measures wall-clock latency until B's `/sync` returns each one.
- [ ] **Step 3:** Record p50, p95, p99, max, and any rate-limit responses (`M_LIMIT_EXCEEDED`).
- [ ] **Step 4:** Repeat with 16KB, 32KB, 64KB content payloads. Note any rejections.
- [ ] **Step 5:** Test `/sync` long-poll behavior: timeout, filter, since token, what happens on disconnect.

### Task 0.2: Yjs over Matrix correctness

**Files:**
- Create (throwaway): `scripts/spike-yjs-matrix.ts`

- [ ] **Step 1:** Two Y.Doc instances, one per account. Both subscribe to the test room.
- [ ] **Step 2:** Have account A insert into a Y.Array, encode update, base64, send via custom event. B receives, decodes, applies.
- [ ] **Step 3:** Verify B's doc state equals A's (`Y.encodeStateAsUpdate(a) === Y.encodeStateAsUpdate(b)` after both have seen all events).
- [ ] **Step 4:** Run a concurrency test: A and B mutate at the same time, send simultaneously, both apply both. Verify convergence.
- [ ] **Step 5:** Test snapshot writer: encode full state, store as room state event, fresh client reads it and skips old timeline.

### Task 0.3: Spike report

- [ ] **Step 1:** Write `specs/062-shared-apps/spike.md` with:
  - Measured latencies (table)
  - Max payload size before rejection
  - Rate limit thresholds
  - Yjs convergence verified yes/no
  - Snapshot strategy verified yes/no
  - Surprises and gotchas
  - **Go / No-go decision** for Phase 1
- [ ] **Step 2:** If no-go, file an updated spec revision before continuing.

**Checkpoint:** Spike report committed. Throwaway scripts deleted from `scripts/`.

---

## Chunk 1: Matrix sync layer

### Task 1.1: Extend matrix-client.ts (TDD)

**Files:**
- Modify: `packages/gateway/src/matrix-client.ts`
- Create: `tests/gateway/matrix-client-extensions.test.ts`

The current `matrix-client.ts` only exposes `createDM`, `joinRoom`, `getRoomMessages`, `whoami`, `sendCustomEvent`. Chunks 2 and beyond depend on a much wider surface — room creation, invites, room state, power levels, members, /sync. Add it all here behind one TDD pass so the rest of the plan can rely on it.

- [ ] **Step 1: Write failing tests** for new methods using a stubbed fetch (or msw):

  **Sync surface:**
  - `sync({ filter?, since?, timeoutMs? })` returns `{ next_batch, rooms: { join, invite, leave }, presence: { events } }` (note: presence is a top-level field on `/sync`, not nested under rooms — needed by Chunk 8 Task 8.2) and threads `?since=` correctly
  - **No `onCustomEvent` helper.** Subscription/dispatch is owned by `MatrixSyncHub` (Task 1.2). `matrix-client.ts` exposes raw `sync()` only — keeping it as a thin Matrix HTTP wrapper.

  **Room lifecycle:**
  - `createRoom({ name, invite[], preset, powerLevels?, initialState? })` returns `{ room_id }` and supports `m.room.name`, invite list, and an initial `m.room.power_levels` override
  - `inviteToRoom(roomId, userId)` returns `void`, surfaces `M_FORBIDDEN` as a typed error
  - `kickFromRoom(roomId, userId, reason?)` returns `void`
  - `leaveRoom(roomId)` returns `void`

  **Room state:**
  - `getRoomState(roomId, eventType, stateKey)` returns content or `null` when missing
  - `getAllRoomStateEvents(roomId, eventType?)` returns the full set (used by snapshot reader to enumerate `{snapshot_id}/{chunk_index}` keys)
  - `setRoomState(roomId, eventType, stateKey, content)` requires sufficient power level; surfaces `M_FORBIDDEN` as typed error

  **Membership and power:**
  - `getRoomMembers(roomId)` returns `[{ userId, membership, displayName? }]` derived from `m.room.member` state
  - `getPowerLevels(roomId)` returns the current `m.room.power_levels` content
  - `setPowerLevels(roomId, content)` writes a new `m.room.power_levels` state event

  **Cross-cutting:**
  - All methods set `AbortSignal.timeout()` — 10s for state/membership, `timeoutMs + 5s` for `/sync` (sync has its own server-side timeout)
  - All methods translate Matrix `errcode` to typed errors (`MatrixForbiddenError`, `MatrixNotFoundError`, `MatrixRateLimitError`, `MatrixUnknownError`); never leak raw response text to callers
  - **No subscription / dispatch APIs in this layer.** Anything that consumes streamed events goes through `MatrixSyncHub` (Task 1.2), which is the single owner of dispatch. This avoids duplicated abstractions where both layers fan out events.
- [ ] **Step 2:** Implement against the failing tests. Match existing `MatrixClient` interface style: a single `createMatrixClient` factory returning an object with all methods.
- [ ] **Step 3:** Verify: `bun run test tests/gateway/matrix-client-extensions.test.ts` green.
- [ ] **Step 4:** Verify: `bun run lint && bun run build` clean.

### Task 1.2: MatrixSyncHub — single account-wide long-poll

**Files:**
- Create: `packages/gateway/src/matrix-sync-hub.ts`
- Create: `tests/gateway/matrix-sync-hub.test.ts`

There is exactly one `MatrixSyncHub` per gateway process. It owns the only `/sync` cursor for the account. `GroupSync` instances register handlers; the hub fans out events. This matches the spec's E.1 topology and avoids per-account rate-limit conflicts from multiple parallel /sync loops.

- [ ] **Step 1: Write failing tests** with a stubbed `MatrixClient`:
  - `start(signal)` calls `client.sync()` in a loop, threading `next_batch` correctly across iterations
  - `start(signal)` aborts cleanly on `signal.abort()`
  - Backs off on errors (1s, 2s, 4s, capped 30s); never throws

  **Room-scoped dispatch** (timeline + room state events):
  - `registerEventHandler(roomId, eventType, handler)` returns a `Disposable`; disposed handlers stop receiving events
  - Multiple handlers for the same `(roomId, eventType)` all fire
  - **Per-room serial dispatch**: handlers for the same room run sequentially; different rooms run in parallel. A test verifies that two handlers for room A see events in /sync order even when handler 1 awaits a slow promise.

  **Account-wide dispatch** (events that don't belong to a single room — `m.presence`, `m.account_data`, `m.to_device` if/when used):
  - `registerGlobalEventHandler(eventType, handler)` returns a `Disposable`; fires for events parsed from the top-level `presence`, `account_data`, or `to_device` arrays of `/sync`, NOT from `rooms.join.*.timeline`
  - **Serial dispatch on a single global queue** — distinct from per-room queues. Global handlers do not block per-room dispatch and vice versa.
  - A test verifies that a `m.presence` handler registered globally receives events from the top-level `presence.events` array of a fake `/sync` response

  **Cursor:**
  - `getNextBatch()` returns the most recent cursor; persistable for crash recovery
- [ ] **Step 2:** Implement `MatrixSyncHub`. Use a per-room async queue (a `Promise` chained per `roomId`) for room-scoped dispatch and a single global async queue for account-wide dispatch. Use `for await` loop, no `setInterval`.
- [ ] **Step 3:** Verify tests + lint + build.

**Ordering contract (write this into the JSDoc of `MatrixSyncHub` AND assert it via tests):**

1. **Room handlers are serial per room** — events from the same `(roomId, *)` arrive in `/sync` order, never concurrently.
2. **Different rooms run in parallel** — handlers for room A do not block handlers for room B.
3. **Global handlers are serial within the global queue** — `m.presence`, `m.account_data`, etc. arrive in order, never concurrently with each other.
4. **There is NO total-ordering guarantee between global and room-scoped handlers from the same `/sync` batch.** A presence event and a timeline op that arrived in the same batch may be dispatched in either order, and may even interleave with later events from a follow-up batch. This is intentional: presence is independent of room state in v1, so the simpler model wins. **If a future feature needs cross-stream ordering** (e.g., "presence change implies ACL change"), it will need a different abstraction — do not silently rely on incidental ordering observed in tests.

A unit test asserts each of these four properties using a fake `/sync` response that mixes room timeline events and top-level presence events, then verifies the dispatch traces are consistent with the contract (and explicitly checks that test runs do **not** assume any specific cross-stream order).

### Task 1.3: Persist /sync cursor across restarts

**Files:**
- Modify: `packages/gateway/src/matrix-sync-hub.ts`
- Modify: `tests/gateway/matrix-sync-hub.test.ts`

- [ ] **Step 1: Write failing tests:**
  - On startup, hub reads `~/system/matrix-sync.json` for last `next_batch`
  - On every successful /sync, hub atomically writes the new cursor (write-tmp + rename)
  - On corrupt cursor file, log + start from `null` (full sync)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

**Checkpoint:** Matrix sync layer complete. Commit: `feat(062): MatrixSyncHub with single account-wide /sync loop`

---

## Chunk 2: Group filesystem + IPC tools (no CRDT yet)

### Task 2.1: Group types and Zod schemas

**Files:**
- Create: `packages/gateway/src/group-types.ts`
- Create: `tests/gateway/group-types.test.ts`

- [ ] **Step 1: Write failing tests** for Zod schemas:
  - `GroupManifest` — room_id, name, slug, owner_handle, joined_at, schema_version
  - `GroupAcl` — read_pl, write_pl, install_pl, policy enum
  - `OpEventContent` — v, update (base64), lamport, client_id, origin, ts
  - `SnapshotEventContent` — v, snapshot_id, generation, chunk_index, chunk_count, state, taken_at_event_id, taken_at, written_by
  - `SnapshotLeaseContent` — v, writer (handle), lease_id, acquired_at, expires_at
  - `GroupDataValueSchema` — concrete shape for values that flow through `group_data` IPC tool / `POST /api/groups/:slug/data`. JSON-serializable: `string | number | boolean | null | GroupDataValueSchema[] | { [k: string]: GroupDataValueSchema }`. Reject `undefined`, functions, `Date`, `BigInt`, circular refs. Cap nesting depth at **16** and total serialized size at **256 KB** (chosen to comfortably hold a long shared note or rich JSON-ish app state without an artificially tight ceiling; route `bodyLimit` is set higher in Task 8.3 so the cap actually fires inside the schema, not at the HTTP layer). The test enumerates each rejection case.
  - `GroupDataRequestSchema` — `{ action: "read" | "write" | "list", app_slug: SafeSlug, key?: string, value?: GroupDataValueSchema }` with conditional refinements (`key` required for `read`/`write`; `value` required for `write`)
  - Group slug regex: `/^[a-z0-9][a-z0-9-]{0,62}$/`
  - Member handle regex: `/^@[a-z0-9_]{1,32}:[a-z0-9.-]{1,253}$/`
- [ ] **Step 2:** Implement with `import { z } from 'zod/v4'`. Use `z.lazy()` for the recursive `GroupDataValueSchema`.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 2.2: GroupRegistry — scan and hydrate

**Files:**
- Create: `packages/gateway/src/group-registry.ts`
- Create: `tests/gateway/group-registry.test.ts`

- [ ] **Step 1: Write failing tests** using a tmp home directory:
  - Empty `~/groups/` → `list()` returns `[]`
  - One valid group dir → `list()` returns one entry
  - Corrupt manifest.json → quarantined to `manifest.json.corrupt-{ts}`, group skipped, error logged
  - `create({ roomId, name, ownerHandle })` → atomic write, slug derived, returns manifest
  - `get(slug)` returns manifest or null
  - `archive(slug)` → moves to `_archive/{slug}-{ts}/`
  - All filesystem writes go through `resolveWithinHome`
- [ ] **Step 2:** Implement. Use `fs/promises`, atomic write helper (write tmp + rename).
- [ ] **Step 3:** Verify tests + lint + build.

### Task 2.3: Gateway HTTP routes — group lifecycle (server-side)

**Files:**
- Create: `packages/gateway/src/group-routes.ts` — **the single authoritative location for `/api/groups/*` routes**. Later chunks (5, 6, 7, 8) modify this file to add data, ACL, share, and members routes. Do NOT create it again elsewhere.
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/group-routes-lifecycle.test.ts`

The kernel reaches gateway state via HTTP loopback (matches existing `app_data` → `/api/bridge/query` pattern from spec 050). The kernel does NOT receive a `groupRegistry` reference. Build the server-side first so the kernel tools have something to call.

**Route shape note**: `join_group` cannot route on a slug because the slug doesn't exist yet — the server derives it from the joined room. So `join` is a top-level route, not `/:slug/join`.

- [ ] **Step 1: Write failing tests** for HTTP routes:
  - `POST /api/groups` body `{ name, member_handles[] }` → calls `matrixClient.createRoom` (with name + invites + power level overrides) → `groupRegistry.create()` → writes initial `m.matrix_os.group` state event → returns `{ slug, room_id }`
  - `POST /api/groups/join` body `{ room_id }` → calls `matrixClient.joinRoom` → fetches `m.room.name` + members + power levels via `matrix-client.ts` extensions → derives slug from canonical alias or generates one → scaffolds `~/groups/{slug}/` → returns `{ slug, manifest }`. **Slug derivation collisions** (existing `~/groups/{slug}/` for a different room_id) append a numeric suffix.
  - `GET /api/groups` → returns array of `{ slug, name, member_count, last_activity }`
  - `GET /api/groups/:slug` → returns the full manifest for an existing group; 404 if unknown
  - `POST /api/groups/:slug/leave` → calls `matrixClient.leaveRoom` → archives dir to `~/groups/_archive/{slug}-{ts}/`
  - All routes use Hono `bodyLimit` middleware (256KB cap for lifecycle routes)
  - All routes injected with `matrixClient` and `groupRegistry` at construction time
  - Auth check: bearer token, return 401 generic on failure
  - Membership check on `:slug` routes: return 404 (not 403) if the caller is not a member, to avoid leaking group existence
- [ ] **Step 2:** Implement `group-routes.ts` exporting `createGroupRoutes({ matrixClient, groupRegistry })` returning a Hono sub-app.
- [ ] **Step 3:** Mount in `server.ts` at `/api/groups`. Wire `matrixClient` + `groupRegistry` constructor injection.
- [ ] **Step 4:** Verify tests + lint + build.

### Task 2.4: Kernel IPC tools — HTTP loopback to gateway

**Files:**
- Create: `packages/kernel/src/group-tools.ts`
- Modify: `packages/kernel/src/ipc-server.ts`
- Modify: `packages/kernel/src/options.ts` — add tool names to `IPC_TOOL_NAMES` allowlist (line 19)
- Create: `tests/kernel/group-tools.test.ts`

The pattern matches `tools/integrations.ts` and the existing `app_data` tool: each kernel tool wraps a `fetch` to `http://localhost:${GATEWAY_PORT}/api/groups/*` with `AbortSignal.timeout(10000)`, parses the typed response, and returns the IPC content array.

- [ ] **Step 1: Write failing tests** with a stubbed gateway HTTP server (msw or hand-rolled):
  - `create_group("Schmidt Family", ["@b:matrix-os.com"])` → POST `/api/groups` → returns `{ slug, room_id }` and surfaces both in the IPC text content
  - `join_group("!abc:matrix-os.com")` → POST `/api/groups/join` body `{ room_id }` → returns the slug derived by the server (kernel does NOT compute it)
  - `list_groups()` → GET `/api/groups`
  - `leave_group("schmidt-family")` → POST `/api/groups/schmidt-family/leave`
  - All tools use `AbortSignal.timeout(10000)`
  - HTTP errors translate to generic IPC text content (never leak gateway error bodies)
  - `GATEWAY_PORT` read from env, defaults to 4000
  - Each tool returns IPC content array per existing convention (no thrown exceptions)
- [ ] **Step 2:** Implement `group-tools.ts` exporting factories that close over `db` (matching the existing `createIpcServer(db, homePath)` signature). No `globalThis`.
- [ ] **Step 3:** Wire tools into `createIpcServer` in `ipc-server.ts` alongside existing tools — same pattern as `app_data`.
- [ ] **Step 4:** Add tool names to `IPC_TOOL_NAMES` array in `options.ts:19`:
  - `mcp__matrix-os-ipc__create_group`
  - `mcp__matrix-os-ipc__join_group`
  - `mcp__matrix-os-ipc__list_groups`
  - `mcp__matrix-os-ipc__leave_group`
  - `mcp__matrix-os-ipc__share_app`
  - `mcp__matrix-os-ipc__group_data`
  - `mcp__matrix-os-ipc__set_app_acl`
- [ ] **Step 5:** Verify tests + lint + build.

### Task 2.5: Wire MatrixSyncHub + GroupRegistry into gateway startup

**Files:**
- Modify: `packages/gateway/src/server.ts`

- [ ] **Step 1:** After homePath resolution and existing matrixClient creation:
  ```ts
  const syncHub = new MatrixSyncHub(matrixClient);
  const groupRegistry = new GroupRegistry(homePath);
  await groupRegistry.scan();
  // GroupSync instances created in Chunk 3
  await syncHub.start(shutdownAbortController.signal);
  ```
- [ ] **Step 2:** Pass `groupRegistry` and `matrixClient` to `createGroupRoutes()` mount.
- [ ] **Step 3:** Manual smoke test: start gateway with empty `~/groups/`, ensure no crash and the hub /sync loop runs without errors.
- [ ] **Step 4:** Verify lint + build.

**Checkpoint:** Groups can be created, joined, listed, left from chat. No shared state yet. Commit: `feat(062): group filesystem + lifecycle IPC tools`

---

## Chunk 3: Yjs sync engine

### Task 3.1: Add Yjs dependencies

**Files:**
- Modify: `packages/gateway/package.json`
- Create: `tests/gateway/yjs-version-compat.test.ts`

`yjs` is the CRDT engine. `lib0` is its low-level encoding peer dep. `y-protocols` ships the standard sync protocol (`syncStep1`/`syncStep2`/`update` message encoding) used by Task 5.2's WebSocket bridge — without it we'd be reinventing a protocol that y-websocket and Hocuspocus already standardize on.

- [ ] **Step 1:** `pnpm add -F @matrix-os/gateway yjs lib0 y-protocols`
- [ ] **Step 2:** **Pin exact versions** (no `^` or `~`) for **both** `yjs` and `y-protocols`. Edit `packages/gateway/package.json` after the install if pnpm wrote a caret. Version skew between gateway and shell, or between `yjs` and `y-protocols` majors, corrupts binary updates.
- [ ] **Step 3:** Run `pnpm install` from repo root to refresh `pnpm-lock.yaml` (per `feedback_commit_all_files.md`).
- [ ] **Step 4:** Commit lockfile change in the same commit as the dependency.
- [ ] **Step 5: Write a version-compat unit test** at `tests/gateway/yjs-version-compat.test.ts`:
  - Imports `yjs` and `y-protocols/sync` (and `y-protocols/awareness` if used)
  - Reads each package's installed version via `import { version } from "yjs/package.json"` (or equivalent — Vitest supports JSON imports out of the box)
  - Defines a constant `EXPECTED_MAJORS = { yjs: 13, "y-protocols": 1 }` (or whatever the installed pair actually is at the time of writing — fill in after Step 1)
  - Asserts that the installed major of each package matches `EXPECTED_MAJORS`
  - Asserts that `y-protocols`'s declared peer dep on `yjs` (via `import peerDeps from "y-protocols/package.json"`) is satisfied by the installed `yjs` major
  - Test fails loudly with a message naming the drifted package — this catches the "someone bumped one of the three deps but not the others" mistake at PR-review time
- [ ] **Step 6:** Verify the new test passes alongside existing gateway tests + lint + build.

This is intentionally a unit test, not a `pretest` hook script. If we ever see actual drift across workspaces despite this test, we can promote it to a script that runs before every test invocation. For now, the test is enough — it runs in CI on every PR and locally on every `bun run test`.

### Task 3.2: GroupSync — pure Yjs logic (TDD)

**Files:**
- Create: `packages/gateway/src/group-sync.ts`
- Create: `tests/gateway/group-sync.test.ts`

- [ ] **Step 1: Write failing tests** with a stubbed MatrixClient and tmp `~/groups/test/data/notes/`:
  - `hydrate()` with no `state.bin` → empty Yjs doc loaded
  - `hydrate()` with existing `state.bin` → doc state restored
  - `applyRemoteOp(updateBase64, sender, ts)` → applies update, persists state.bin atomically, appends to log.jsonl, fires onChange
  - `applyLocalMutation(fn)` runs `fn(doc)` → encodes update → calls `matrixClient.sendCustomEvent` → on success persists, on failure appends to queue.jsonl
  - **Semantic replay invariant** (NOT byte equality): applying `[op1, op2, op3]` in any order yields semantically identical doc state, defined as `JSON.stringify(doc.toJSON())` equality. `Y.encodeStateAsUpdate(doc)` byte equality is **not** asserted — Yjs does not guarantee it (insertion order, GC state, and merge timing affect the binary form). The spike (open question #3 in spec) measures whether byte equality happens to hold in practice; if so, a future hardening pass can tighten this. For now, semantic convergence is the contract.
  - `state.bin` write is atomic (write tmp, rename)
  - `last_sync.json` updates after `state.bin`, never before
  - Quarantine bad updates to `quarantine.jsonl`, do not crash sync loop
- [ ] **Step 2:** Implement. Use `Y.Doc`, `Y.encodeStateAsUpdate`, `Y.applyUpdate` from `yjs`. Use `fs/promises` only — no sync writes.
- [ ] **Step 3:** Run tests until green.

### Task 3.3: Conflict property test

**Files:**
- Create: `tests/gateway/group-sync-conflict.property.test.ts`

- [ ] **Step 1:** Use `fast-check` to generate random sequences of mutations across 3 simulated GroupSync instances. **Property: after exchanging all events, `JSON.stringify(instance.doc.toJSON())` is identical across all three instances.** This is semantic convergence — Yjs's actual guarantee. Do **not** assert byte equality on `state.bin` or `Y.encodeStateAsUpdate` output; that is implementation-defined and may legitimately differ between converged docs.
- [ ] **Step 2:** Add `fast-check` as a dev dep if not already present.
- [ ] **Step 3:** Run with at least 200 generated cases. Fix any non-convergence.
- [ ] **Step 4:** When the spike (open question #3) returns its measurement of whether byte equality happens to hold in practice, file a follow-up note here. If byte equality does hold reliably, a future hardening pass can add a stronger assertion as a redundant check; until then, semantic convergence is the contract.

### Task 3.4: Queue + offline replay

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Modify: `tests/gateway/group-sync.test.ts`

- [ ] **Step 1: Write failing tests:**
  - When MatrixClient throws on send, mutation is queued
  - On `drainQueue()`, queued mutations send in order
  - Queue cap: 10000 events, drop-oldest with logged warning
  - Send retry: exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap)
  - After 30 minutes of failure, surface persistent error to onError listener
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 3.5: Wire GroupSync into startup via MatrixSyncHub

**Files:**
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/src/group-registry.ts`

- [ ] **Step 1:** After `groupRegistry.scan()` and BEFORE `syncHub.start()`, instantiate one `GroupSync` per group:
  ```ts
  for (const manifest of groupRegistry.list()) {
    const sync = new GroupSync({ manifest, matrixClient, syncHub, homePath });
    await sync.hydrate();
    sync.registerHandlers(syncHub);  // GroupSync registers (roomId, eventType) handlers; no own /sync loop
    groupRegistry.attachSync(manifest.slug, sync);
  }
  await syncHub.start(shutdownAbortController.signal);
  ```
- [ ] **Step 2:** `GroupSync.hydrate()` MUST throw on corrupt `state.bin` rather than starting with empty state. Caller catches, quarantines the corrupt file, and creates a fresh GroupSync. Test this path explicitly.
- [ ] **Step 3:** On graceful shutdown: stop accepting new mutations → drain `queue.jsonl` (best-effort, with timeout) → persist final `state.bin` → return.
- [ ] **Step 4:** Manual smoke test in Docker: two gateway containers in the same Matrix room exchange Yjs updates.
- [ ] **Step 5:** Verify lint + build.

**Checkpoint:** Two gateway instances on the same Matrix room can exchange Yjs updates and converge. Commit: `feat(062): Yjs sync engine over Matrix events`

---

## Chunk 4: Snapshots in room state (lease-based)

### Task 4.1: Snapshot reader (build first — needed by lease writer for verification)

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Modify: `tests/gateway/group-sync.test.ts`

The reader-side atomicity contract is mandatory regardless of writer model. Build it first so the writer can verify its own snapshots end-to-end during tests.

- [ ] **Step 1: Write failing tests** for `loadLatestSnapshot(roomId, appSlug)`:
  - Reads ALL `m.matrix_os.app.{appSlug}.snapshot` room state events
  - Groups by `snapshot_id`, picks the highest `generation`
  - For the chosen snapshot, verifies all `chunk_count` chunks are present and share the same `snapshot_id`
  - **Mixed chunk sets are rejected**, not silently merged. A test creates chunks `{snapshot_id: A, chunk: 0}`, `{snapshot_id: B, chunk: 1}`, `{snapshot_id: A, chunk: 2}` and asserts the loader returns the previous-generation snapshot or `null`.
  - On `null`, `hydrate()` falls back to full timeline replay.
  - Concatenates chunks in `chunk_index` order, base64-decodes, returns Yjs binary.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 4.2: Snapshot lease — acquire, observe, stand down

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Create: `tests/gateway/group-sync-lease.test.ts`

- [ ] **Step 1: Write failing tests** for `SnapshotLeaseManager`:
  - `tryAcquire(roomId, appSlug)` reads current `m.matrix_os.app.{appSlug}.snapshot_lease` state event
  - If no lease, or `expires_at < now`: writes a new lease with `writer = self.handle`, `lease_id = ulid()`, `expires_at = now + leaseDurationMs` (default 600000); returns the new `lease_id`
  - If valid lease held by self: returns existing `lease_id` (renew not strictly required mid-window)
  - If valid lease held by other: returns `null` (caller skips this snapshot opportunity)
  - On inbound `snapshot_lease` event from another writer with later timestamp: local lease is invalidated, in-flight snapshot writes are cancelled
  - **Race property test**: two `SnapshotLeaseManager` instances racing on the same fake Matrix homeserver — exactly one succeeds in writing chunks under its `lease_id`; the other observes the winner and stands down. Test runs 100 iterations.
- [ ] **Step 2:** Implement. Use `ulid` package (already a small dep, or use `randomUUID` if ulid not yet present — flag for review).
- [ ] **Step 3:** Verify tests + lint + build.

### Task 4.3: Snapshot writer (lease-gated)

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Modify: `tests/gateway/group-sync.test.ts`

- [ ] **Step 1: Write failing tests:**
  - Snapshot trigger: 50 ops or 5 minutes since last snapshot (whichever first), AND own power level ≥ ACL `install_pl`, AND `tryAcquire()` returned a `lease_id`
  - Writer encodes Yjs state via `Y.encodeStateAsUpdate(doc)`
  - Splits into chunks ≤ 56KB content size each (leaving headroom for JSON envelope)
  - Each chunk written as `state_key = "{lease_id}/{chunk_index}"` with full content per Section C
  - Total chunks must be ≤ ⌈256KB / 56KB⌉ = 5; oversize → log warning, increment `snapshot.oversize` metric, **do not** attempt partial write
  - On any chunk write failure: stop, log, surface error — do NOT leave partial chunks (the lease + monotonic generation will let the next writer reclaim)
  - Snapshot includes `taken_at_event_id` of the latest applied op at the moment encoding started
  - **Concurrency property test**: two writers racing produce snapshots with different `lease_id`s; the reader from Task 4.1 selects exactly one of them (highest generation) and never returns mixed chunks
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 4.4: Cold-start performance test

**Files:**
- Modify: `tests/gateway/group-sync.test.ts`

- [ ] **Step 1:** Cold start with 1000-event fake timeline + valid snapshot completes in <1s in test (in-process fake Matrix, no network).
- [ ] **Step 2:** Cold start with corrupt snapshot falls back to full timeline replay and still completes correctly.
- [ ] **Step 3:** Verify lint + build.

**Checkpoint:** Cold-start performance optimized; concurrent snapshot writes are safe by construction. Commit: `feat(062): lease-gated snapshot writer + atomic chunk reader`

---

## Chunk 5: WS bridge + shell mirror

This chunk gets one app to read and write shared state from a browser. No presence, no member lists, no `group_data` cross-channel — those land in Chunk 8 after ACL is in place. The brutally narrow first slice is: gateway WS bridge + shell mirror Y.Doc + React hooks.

### Task 5.1: Add Yjs dependencies to the shell

**Files:**
- Modify: `shell/package.json`
- Modify: `pnpm-lock.yaml` (auto-updated)

The gateway picked up `yjs`, `lib0`, and `y-protocols` in Task 3.1. The shell needs the **same three packages, at the same exact versions**, to instantiate the mirror `Y.Doc` and speak the standard sync protocol over the WebSocket from Task 5.2. Version skew between gateway and shell would corrupt binary updates.

- [ ] **Step 1:** `pnpm add -F shell yjs lib0 y-protocols` (use the actual workspace name as it appears in `shell/package.json`; verify before running).
- [ ] **Step 2:** Pin to the same exact versions installed in Task 3.1 — no `^` or `~`. Copy the version strings literally from `packages/gateway/package.json`.
- [ ] **Step 3:** Run `pnpm install` from repo root to refresh `pnpm-lock.yaml` (per `feedback_commit_all_files.md`).
- [ ] **Step 4:** Add a comment at the top of `shell/src/lib/group-bridge.ts` documenting the version coupling: "Yjs version MUST match `packages/gateway/package.json`. Mismatch corrupts binary updates."
- [ ] **Step 5:** Commit lockfile change in the same commit as the dep.

### Task 5.2: WebSocket bridge (server side)

**Files:**
- Create: `packages/gateway/src/group-ws.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/group-ws.test.ts`

The WS endpoint bridges the iframe's mirror `Y.Doc` to the gateway's authoritative `Y.Doc` in `GroupSync`. Use the standard Yjs sync protocol (`syncStep1` → `syncStep2` → `update` messages) rather than inventing one — this is the same protocol y-websocket and Hocuspocus use, and it makes future migration trivial.

- [ ] **Step 1: Write failing tests:**
  - WS upgrade at `/ws/groups/:slug/:app` requires bearer + membership + ACL `read_pl`
  - On connect, server sends Yjs `syncStep1` (state vector) to the client; client replies with `syncStep2` containing missing updates; both sides converge
  - Inbound message types: `update` (Yjs binary update from client), `awareness` (deferred — placeholder rejection in v1)
  - Outbound message types: `update` (Yjs binary update from server), `error`
  - Per-connection state — no shared mutable buffers across sockets
  - ACL changes mid-connection: re-check on every inbound `update`; close socket with `error` message and code 4403 if downgraded below `read_pl`
- [ ] **Step 2:** Implement using Hono's WebSocket support. Bridge `GroupSync.onChange` to all connected WebSockets for the same `(group_slug, app_slug)` tuple.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 5.3: shell os-bridge.ts — MatrixOS.shared client (mirror Y.Doc)

**Files:**
- Modify: `shell/src/lib/os-bridge.ts`
- Create: `shell/src/lib/group-bridge.ts` — WebSocket client + mirror `Y.Doc` lifecycle
- Modify: `tests/shell/os-bridge.test.ts`

The iframe runs a **mirror `Y.Doc`** that syncs with the gateway's authoritative doc over `/ws/groups/{slug}/{app}`. The mirror is never the source of truth — on iframe reload it re-syncs from the gateway. This pattern matches Hocuspocus/y-websocket and is the only way to get a `Y.Doc` reference into the iframe without putting authoritative state there.

- [ ] **Step 1: Write failing tests** with a fake gateway WebSocket implementing the Yjs sync protocol:
  - `MatrixOS.shared.get(key)`, `set(key, value)`, `delete(key)`, `list()` — operate on the mirror's `Y.Map("kv")` and ship updates over WS
  - `MatrixOS.shared.doc()` returns the **mirror `Y.Doc`** instance (never the authoritative one — that lives in the gateway)
  - `MatrixOS.shared.onChange(cb)` fires on remote updates received from gateway
  - Connection lifecycle: open WS on first `MatrixOS.shared.*` call, close on iframe unload
  - On reconnect after disconnect, mirror re-syncs full state from gateway via the standard Yjs sync protocol (`syncStep1` → `syncStep2`)
  - `MatrixOS.group.id`, `slug`, `name`, `me` populated when iframe is opened from a group context (group context comes from query param `?group={slug}`); `MatrixOS.group.members` returns `[]` until Chunk 8 wires the member list
  - `MatrixOS.group` is `null` when iframe is opened outside a group
- [ ] **Step 2:** Implement `group-bridge.ts` with the mirror lifecycle. Adds ~30KB to the shell bundle — accepted cost.
- [ ] **Step 3:** Extend `os-bridge.ts` postMessage handler with `shared:*` and `group:*` action types that delegate to `group-bridge.ts`.
- [ ] **Step 4:** Verify tests + lint + build.

### Task 5.4: React hooks

**Files:**
- Create: `shell/src/hooks/useSharedDoc.ts`
- Create: `shell/src/hooks/useSharedKey.ts`
- Create: `tests/shell/useSharedDoc.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - `useSharedDoc(name)` returns the **mirror `Y.Doc`** and re-renders when remote updates arrive
  - `useSharedKey(key)` reads/writes a `Y.Map("kv")` entry, re-renders on change
  - Both hooks clean up subscriptions on unmount
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

**Checkpoint:** One iframe app can read/write shared state from a browser. No presence, no cross-channel access yet. Commit: `feat(062): WS bridge + shell mirror Y.Doc`

---

## Chunk 6: ACL enforcement

### Task 6.1: ACL state event read/write

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Create: `tests/gateway/group-acl.test.ts`

- [ ] **Step 1: Write failing tests:**
  - On startup, fetch `m.matrix_os.app_acl` for each installed app from room state
  - Cache ACL in `~/groups/{slug}/acl/{app}.json`
  - On inbound op, check sender power level against `write_pl` — drop if denied
  - On outbound op, check own power level against `write_pl` — return error if denied
  - On ACL state event change, refresh cache before processing next op
- [ ] **Step 2:** Implement. Match power level lookup to existing Matrix room state event format.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 6.2: set_app_acl IPC tool

**Files:**
- Modify: `packages/kernel/src/group-tools.ts`
- Modify: `tests/kernel/group-tools.test.ts`

- [ ] **Step 1: Write failing test:**
  - `set_app_acl("schmidt-family", "notes", { write_pl: 50 })` → calls `setRoomState` with the new ACL
  - Returns 403 if caller lacks `install_pl`
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

**Checkpoint:** Per-app permissions enforced end-to-end. Commit: `feat(062): per-app ACL via Matrix room state`

---

## Chunk 7: share_app + auto-clone flow

### Task 7.1: share_app IPC tool

**Files:**
- Modify: `packages/kernel/src/group-tools.ts`
- Modify: `tests/kernel/group-tools.test.ts`

- [ ] **Step 1: Write failing test:**
  - `share_app("notes", "schmidt-family")` reuses existing `installApp` to copy `~/apps/notes` → `~/groups/schmidt-family/apps/notes`
  - Writes initial `m.matrix_os.app_acl` state event with default policy
  - Sends `m.matrix_os.app_install` timeline event so other members' kernels notice
  - Refuses if caller lacks `install_pl`
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 7.2: Auto-clone on app_install event

**Files:**
- Modify: `packages/gateway/src/group-sync.ts`
- Modify: `tests/gateway/group-sync.test.ts`

- [ ] **Step 1: Write failing test:**
  - On inbound `m.matrix_os.app_install` event, fetch app code from sender (via existing app-upload mechanism or new `getRoomState` for code blob)
  - Clone into `~/groups/{slug}/apps/{app}/`
  - Spawn new GroupSync slot for the app
  - User sees notification: "X shared an app with the group"
  - User can opt out via prompt
- [ ] **Step 2:** Implement. Decide app code transport: prefer reusing `app-upload.ts` to push tarball to platform, then `app_install` event carries the URL. (Alternative: chunked room state events for the tarball — slower, more complex, defer.)
- [ ] **Step 3:** Verify tests + lint + build.

**Checkpoint:** End-to-end share flow works locally. Commit: `feat(062): share_app and auto-clone via Matrix events`

---

## Chunk 8: Members, presence, and cross-channel access

This chunk adds the read-only observability layer (member list, presence) and the `group_data` IPC tool that lets non-iframe channels (Telegram, Discord, voice agents) reach the same shared state. It comes after ACL because writes via `group_data` need ACL enforcement.

**Important scoping decision**: presence in v1 is **observed only**. The gateway is not the Matrix presence publisher for the user session — the user's first-class Matrix client (browser, mobile, etc.) is. So Matrix OS reads `m.presence` events from `/sync` and surfaces them, but does NOT write them. This avoids the gateway accidentally claiming the user is "online" when they only have a backend container running.

If a future spec wants the gateway to publish presence, it will need a separate "session liveness" signal — out of scope here.

### Task 8.1: Member list (observed)

**Files:**
- Modify: `packages/gateway/src/group-sync.ts` — add `m.room.member` handler + member list cache
- Modify: `packages/gateway/src/group-routes.ts` — `GET /api/groups/:slug/members`
- Modify: `packages/gateway/src/group-ws.ts` — broadcast `members_changed` to subscribers
- Create: `tests/gateway/group-members.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `GET /api/groups/:slug/members` returns `[{ handle, role, membership }]` derived from `m.room.member` state events; `role` mapped from `m.room.power_levels` (owner=100, editor=50, viewer=0; intermediate values bucketed)
  - Member list cache `~/groups/{slug}/members.cache.json` is updated on every `m.room.member` event seen via the sync hub; the cache is for offline reads only — the route always returns a fresh derivation when the gateway is online
  - `members_changed` events broadcast to all WebSocket subscribers of `(group_slug, *)` when the member set changes
  - Cache cap (1000 members) enforced per spec Section "Resource Management"
- [ ] **Step 2:** Implement. Hook into the existing `MatrixSyncHub` registration in `GroupSync.registerHandlers()`.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 8.2: Presence (observed only)

**Files:**
- Modify: `packages/gateway/src/group-sync.ts` — add `m.presence` handler
- Modify: `packages/gateway/src/group-routes.ts` — `GET /api/groups/:slug/presence`
- Modify: `packages/gateway/src/group-ws.ts` — broadcast `presence_changed` to subscribers
- Create: `shell/src/hooks/useGroupMembers.ts` — exposes both members and presence
- Create: `tests/gateway/group-presence.test.ts`

**v1 is read-only.** No `POST /presence`, no `set_group_presence` IPC tool. The gateway observes `m.presence` events from `/sync` and surfaces them; it does not publish.

- [ ] **Step 1: Write failing tests:**
  - `GET /api/groups/:slug/presence` returns `{ "@user:matrix-os.com": { status: "online" | "unavailable" | "offline", last_active_ago: 12345 } }` — the standard Matrix `m.presence` content shape, scoped to the group's members
  - `presence_changed` WS event fires when any tracked member's presence changes
  - Members not in the group are filtered out
  - `useGroupMembers()` shell hook returns `{ members, presenceByHandle }` and re-renders on either changing
  - **Negative test**: there is no `POST /api/groups/:slug/presence` route. v1 explicitly does not expose a setter.
  - **Negative test**: there is no `set_group_presence` kernel IPC tool. The kernel cannot publish presence.
- [ ] **Step 2:** Implement. The `m.presence` handler at the `MatrixSyncHub` level is account-wide (presence isn't per-room in Matrix); `GroupSync` filters to its room's members for delivery.
- [ ] **Step 3:** Verify tests + lint + build.

### Task 8.3: group_data IPC tool (cross-channel access)

**Files:**
- Modify: `packages/kernel/src/group-tools.ts` — add `group_data` tool
- Modify: `packages/gateway/src/group-routes.ts` — add `POST /api/groups/:slug/data` (read/write/list)
- Modify: `tests/kernel/group-tools.test.ts`
- Modify: `tests/gateway/group-routes-lifecycle.test.ts` — or create `tests/gateway/group-routes-data.test.ts` if more readable

The kernel-side `group_data` tool gives agents from any channel (Telegram, Discord, voice) the same access to shared state that iframe apps have via `MatrixOS.shared`. Mirrors the existing `app_data` tool from spec 050. Must come after ACL (Chunk 6) so write checks can be enforced.

- [ ] **Step 1: Write failing tests** for the gateway route:
  - `POST /api/groups/:slug/data` body validated by `GroupDataRequestSchema` from `group-types.ts` (defined in Task 2.1) — no ad-hoc inline schema, single source of truth for the value shape
  - `read` returns the current value of `Y.Map("kv").get(key)`
  - `write` calls `GroupSync.applyLocalMutation(doc => doc.getMap("kv").set(key, value))` — this funnels through the same op-emit path as iframe writes, so ACL enforcement from Chunk 6 catches denied writes
  - `list` returns all keys
  - Bearer auth + membership + Hono `bodyLimit` set to **512 KB** for this route — deliberately higher than `GroupDataValueSchema`'s 256 KB value cap so that an oversize payload is rejected by the **schema** with a precise validation error, not by the HTTP layer with a generic 413. The 512 KB ceiling still hard-stops pathological requests at the HTTP boundary.
  - **Value validation**: `value` is parsed through `GroupDataValueSchema` (Task 2.1) before insertion — rejects `undefined`, functions, `Date`, `BigInt`, circular refs, depth > 16, serialized size > 256 KB. The route returns 400 with a generic error code on validation failure (no Zod error leakage).
  - **Edge test**: a 257 KB value is rejected by the schema (not the bodyLimit). A 513 KB value is rejected by the bodyLimit before reaching the schema. Both produce generic 4xx errors with no internal detail.
  - The same schemas are imported by the kernel-side tool wrapper so the IPC tool surface uses the same types end-to-end.
- [ ] **Step 2: Write failing tests** for the kernel tool:
  - `group_data({ action, group_slug, app_slug, key?, value? })` → POST `/api/groups/:slug/data` with `AbortSignal.timeout(10000)`
  - HTTP errors translate to generic IPC text content
  - Returns IPC content array per existing convention
- [ ] **Step 3:** Implement both sides.
- [ ] **Step 4:** Verify tests + lint + build.

**Checkpoint:** Members observed, presence observed, agents from any channel can read/write shared state with ACL enforcement. Commit: `feat(062): observed members + presence + group_data IPC tool`

---

## Chunk 9: Demo + e2e

### Task 9.1: Migrate one default app to optional group mode

**Files:**
- Modify: `~/apps/notes/` (or whichever default app is chosen — TBD with user)
- Modify: app's `matrix.json` to declare `shared: true`
- Modify: app's React code to conditionally use `MatrixOS.shared` when `MatrixOS.group !== null`

- [ ] **Step 1:** Pick the demo app (recommend: notes — simple data shape, visual collaboration value).
- [ ] **Step 2:** Refactor data layer to read from the **mirror** `Y.Doc` via `MatrixOS.shared.doc().getMap("notes")` when in group context, fall back to `MatrixOS.db.*` when personal.
- [ ] **Step 3:** Add a "Share with group" button in the app UI.
- [ ] **Step 4:** Verify in personal mode (no regression).
- [ ] **Step 5:** Verify in group mode (live updates between two browser windows).

### Task 9.2: Playwright e2e

**Files:**
- Create: `tests/e2e/shared-app.spec.ts`
- Create: `tests/e2e/screenshots/shared-app/`

- [ ] **Step 1:** Two browser contexts (User A, User B) signed in via Clerk test users.
- [ ] **Step 2:** A creates group, invites B. B accepts.
- [ ] **Step 3:** A shares notes app. B's window shows notification, accepts.
- [ ] **Step 4:** A creates a note. B's window shows it within 2 seconds.
- [ ] **Step 5:** B edits the note. A sees the edit.
- [ ] **Step 6:** Screenshot at each step (per `feedback_playwright_screenshots.md`).
- [ ] **Step 7:** Verify: `bun run test:e2e tests/e2e/shared-app.spec.ts` green.

### Task 9.3: Manual test scenario

**Files:**
- Create: `specs/062-shared-apps/manual-test.md`

- [ ] **Step 1:** Document the full flow as a manual test for human verification before merging:
  - Two browsers, two real accounts
  - Walk through create → invite → share → edit → offline → reconnect
  - Each step has expected UI state and screenshots

**Checkpoint:** End-to-end demo works in Docker. Commit: `feat(062): shared notes demo + Playwright e2e`

---

## Chunk 10: Pre-merge hardening

### Task 10.1: Review against quality gates

**Files:**
- All new files in this spec

- [ ] **Step 1:** Run `/review-spec` skill against `specs/062-shared-apps/spec.md`.
- [ ] **Step 2:** Run `superpowers:requesting-code-review` against the implementation.
- [ ] **Step 3:** Verify no `globalThis` usage in new code.
- [ ] **Step 4:** Verify no `appendFileSync` / `writeFileSync` in handlers.
- [ ] **Step 5:** Verify all `fetch` calls have `AbortSignal.timeout`.
- [ ] **Step 6:** Verify Hono `bodyLimit` middleware on all mutating routes.
- [ ] **Step 7:** Verify input validation at every boundary (Zod schemas).

### Task 10.2: Coverage check

- [ ] **Step 1:** `bun run test --coverage` → check `group-sync.ts`, `group-registry.ts`, `group-tools.ts`, `matrix-sync-hub.ts` all ≥ 99%.
- [ ] **Step 2:** Add tests for any uncovered branches.

### Task 10.3: Doc updates

- [ ] **Step 1:** Update `CLAUDE.md` Active Technologies section with Yjs entry.
- [ ] **Step 2:** Update `CLAUDE.md` Recent Changes with 062 entry.
- [ ] **Step 3:** Run `/update-docs` skill (per CLAUDE.md "After major features").

### Task 10.4: PR

- [ ] **Step 1:** Per `feedback_pr_for_big_changes.md`: this is multi-feature, multi-package — open as a PR, do not push to main.
- [ ] **Step 2:** Per `feedback_test_before_push.md`: user must verify in Docker before push.
- [ ] **Step 3:** PR title: `feat(062): shared apps via CRDT-over-Matrix`
- [ ] **Step 4:** PR body: link spec, plan, spike report. Include a video/gif of two browsers editing the same note live.

**Final checkpoint:** Spec complete, merged, demo recorded.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Matrix `/sync` rate-limited at production scale | Medium | High | Phase 0 spike measures it; the single account-wide `MatrixSyncHub` minimizes cursor count to one. If still bad, fall back to SSE bridge from gateway. |
| Yjs binary update format changes between versions | Low | High | Pin exact version on **both** gateway and shell — they MUST match. Document migration path; never auto-upgrade. |
| Two writers race for snapshot lease at the same instant | Medium | Low | Matrix room state LWW resolves the lease event race deterministically. Worst case is one duplicate snapshot under a different `snapshot_id`; the reader's atomicity contract (highest generation, complete chunk set) selects exactly one. |
| Stuck snapshot lease (writer crashes mid-snapshot) | Low | Medium | Leases expire after 10 minutes (default). Any `install_pl` member can take over after expiry. Spike measures the right default. |
| Synapse rejects `m.matrix_os.*` event types via federation rules | Low | Medium | Spike verifies; fall back to `m.room.message` with a `matrix_os.op_type` field in content. |
| Iframe ↔ shell ↔ gateway round-trip latency > Matrix latency | Medium | Medium | Profile in spike. **Mitigation MUST preserve the gateway-as-source-of-truth invariant.** Acceptable mitigations: (a) batch local mutations with a 16ms debounce in `group-bridge.ts` before shipping over WS; (b) skip the postMessage round-trip for read-only `get`/`list` by caching in the iframe's mirror Y.Doc (already the design); (c) raise WS message frequency. **Not acceptable**: moving the authoritative Y.Doc into the iframe — that reopens the multi-tab divergence problem the spec just closed. |
| App authors make incompatible schema changes | High | Medium | Out of scope; document Yjs schema-evolution patterns in app dev guide. |
| Cold start of large group exceeds 5s target | Low | Low | Tune snapshot frequency; chunked snapshots; lazy app load. |
| Gateway version skew between two members causes Yjs binary mismatch | Medium | High | Pin Yjs major version in both `packages/gateway/package.json` and `shell/package.json`; gate Matrix OS upgrades on Yjs major version compatibility; if a major bump is unavoidable, force a snapshot regenerate during migration. |

## Out of scope (carry to follow-up specs)

- Federated groups across homeservers
- E2E encryption of shared state
- Group voice / video
- Shared agent memory (group-level `soul.md`)
- Cross-group queries
- Field-level ACLs
- Nested groups / sub-groups
- Conflict-free schema migrations (handled by app authors via Yjs doc versioning, not platform)
