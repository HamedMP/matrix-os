# Spec 062: Shared Apps (CRDT over Matrix)

**Created**: 2026-04-11
**Status**: Draft
**Depends on**: 038-app-platform, 039-app-store, 050-app-data-layer, 041-social
**Constitution alignment**: I (Data ownership: "Shared" scope), VI (App ecosystem: app sharing), VII (Multi-tenancy: shared workspaces), VIII (Defense in depth)

## Problem

The existing app model is strictly single-user. Two family members each running the "grocery list" app see two independent lists: the same code, separate state. Forking via spec 039 copies code but not data. Spec 050 gives every user their own Postgres schema-per-app — there is no shared namespace.

What users actually want for families and group projects:

1. One person builds an app; others **use the same instance** with **shared state**
2. Edits propagate live to every member
3. Each member can edit while offline; conflicts resolve cleanly on reconnect
4. Data ownership stays with the **group**, not the platform — leaving the group is a clean cut
5. Permissions follow group membership, not ad-hoc per-app ACLs the user has to manage
6. Works without "the builder must keep their laptop open"

There is no group concept in the codebase today. Matrix protocol is partially wired (`packages/gateway/src/matrix-client.ts`) but only for request/response operations — no live event subscription, no custom event consumption, no room state reads.

## Solution

A Matrix room **is** a group. Shared app state lives **in the room** as a combination of (1) an append-only stream of CRDT operations in the timeline and (2) periodic snapshots in room state for fast cold-starts. The kernel maintains a local Yjs replica per app per group. Sync is bidirectional via Matrix `/sync` long-poll.

This satisfies the constitution's "Shared" ownership scope: collaborators co-own the room, the room *is* the data, and Matrix federation handles replication and identity.

### A: Group = Matrix Room

A group is a Matrix room with extra room state events:

- `m.room.name` — display name ("The Schmidt Family")
- `m.room.power_levels` — role definitions (owner=100, editor=50, viewer=0)
- `m.matrix_os.group` (state_key=`""`) — group manifest: schema version, default app ACL policy, group avatar

Group identity is the room ID (`!abc123:matrix-os.com`). For UX, a group also has a slug derived from `m.room.canonical_alias` or generated. All members are Matrix users with handles `@user:matrix-os.com` — already supported by `identity.ts`.

No new identity system. No new database table for groups. The room *is* the group.

### B: Filesystem Layout

```
~/groups/
  {group_slug}/
    manifest.json              -- {room_id, name, slug, owner_handle, joined_at, schema_version}
    members.cache.json         -- last-seen member list (cache; truth is room state)
    apps/
      {app_slug}/              -- app code, copied from publisher's ~/apps/{app_slug}
        matrix.json
        index.html / src/...
    data/
      {app_slug}/
        state.bin              -- Yjs document binary (Y.encodeStateAsUpdate)
        log.jsonl              -- recent timeline events cache (last 30d, capped 5MB)
        queue.jsonl            -- outbound mutations queued while offline
        last_sync.json         -- {last_event_id, last_snapshot_event_id, lamport}
    acl/
      {app_slug}.json          -- cached ACL state event (truth is room state)
```

`~/groups/` sits alongside `~/apps/`, `~/data/`, `~/system/`. Personal apps and shared apps coexist. The same code can be installed both ways — once into `~/apps/{slug}/` (personal) and once into `~/groups/{group}/apps/{slug}/` (shared).

### C: State Lives in Two Matrix Event Types

**Timeline events (append-only mutation log):**

```
event_type: m.matrix_os.app.{app_slug}.op
content: {
  v: 1,                              -- protocol version
  update: "<base64 Y.Update binary>", -- Yjs update (≤32KB raw, splits if larger)
  lamport: 4823,                     -- Lamport clock for ordering hints (Yjs doesn't need this strictly but helps debugging)
  client_id: "h7g3...",              -- Yjs client ID (random per kernel boot)
  origin: "@hamed:matrix-os.com",    -- redundant with sender; explicit for app-level checks
  ts: 1712780000000
}
```

Timeline events are immutable, replayable, and idempotent under Yjs merge semantics. Replaying any subset in any order produces the same final state.

**Room state events (current snapshot, last-writer-wins by key):**

```
event_type: m.matrix_os.app.{app_slug}.snapshot
state_key: "{snapshot_id}/{chunk_index}"   -- snapshot_id scopes the chunk set
content: {
  v: 1,
  snapshot_id: "01HXYZ...",         -- ULID; identical across all chunks of one snapshot
  generation: 4823,                 -- monotonic counter, higher wins on conflict
  chunk_index: 0,                   -- 0..chunk_count-1
  chunk_count: 3,
  state: "<base64 Y.encodeStateAsUpdate fragment>",
  taken_at_event_id: "$abc...",     -- last timeline event included in this snapshot
  taken_at: 1712780000000,
  written_by: "@hamed:matrix-os.com"
}
```

**Snapshot atomicity contract:** Readers MUST select the highest-generation `snapshot_id` for which all `chunk_count` chunks are present and share the same `snapshot_id`. Mixed chunk sets from concurrent writers MUST be rejected — fall back to the previous complete snapshot or full timeline replay. The `state_key` includes the `snapshot_id` so concurrent writers cannot interleave chunks under the same key.

**Snapshot writer lease:**

```
event_type: m.matrix_os.app.{app_slug}.snapshot_lease
state_key: ""                       -- single lease per app
content: {
  v: 1,
  writer: "@hamed:matrix-os.com",
  lease_id: "01HXY...",             -- ULID, must match the snapshot_id the writer publishes
  acquired_at: 1712780000000,
  expires_at: 1712780600000         -- acquired_at + lease_duration_ms (default 10 minutes)
}
```

A would-be snapshot writer first reads the current lease state event:
1. **No lease, or `expires_at < now`** → write a new lease event with `writer = self`, `lease_id = new ULID`, `expires_at = now + 10min`. Then write snapshot chunks using `lease_id` as `snapshot_id`.
2. **Valid lease held by self** → reuse `lease_id`, write new snapshot generation.
3. **Valid lease held by another member** → skip; that member is the active writer for this window.

If two members race step 1, Matrix room state LWW resolves the lease race deterministically — the loser sees the winner's lease on next /sync and stands down before writing chunks. Worst case is one duplicate snapshot before the loser observes the winner; the snapshot reader contract above tolerates this because both snapshots are internally consistent (each has its own `snapshot_id`).

Snapshots are an optimization: a fresh client loads the latest complete snapshot, then replays only timeline events newer than `taken_at_event_id`. Without snapshots a long-running app would still work — just slowly on cold start.

**ACL events (per-app permissions):**

```
event_type: m.matrix_os.app_acl
state_key: {app_slug}
content: {
  v: 1,
  read_pl: 0,                       -- min power level to read
  write_pl: 50,                     -- min power level to write
  install_pl: 100,                  -- min power level to install/upgrade the app code
  policy: "open" | "moderated" | "owner_only"
}
```

Default policy on group creation: `read_pl=0, write_pl=0, install_pl=100`. Family-style. Group projects can tighten via UI or chat.

### D: Yjs as the CRDT

Yjs is the CRDT engine. Why Yjs and not Automerge:

- Smaller bundle (~30KB) — matters for iframe apps
- Binary update format is compact and append-mergeable
- Mature React bindings (`y-react`, custom hooks)
- Update messages are deltas (cheap), not full document state
- Native types: `Y.Map`, `Y.Array`, `Y.Text`, sub-documents
- `Y.encodeStateAsUpdate(doc)` and `Y.applyUpdate(doc, update)` are the only two API calls the sync layer needs

Apps use Yjs types directly via `MatrixOS.shared.doc()` (see Section F). For simple key-value cases, `MatrixOS.shared.get()` / `set()` wraps a `Y.Map` named `"kv"`.

### E: Sync Engine

The sync engine has two layers:

**E.1: `MatrixSyncHub` (one per gateway process, account-wide)**

A single long-running `/sync` long-poll loop owns the connection to the user's Matrix homeserver. There is exactly one `/sync` cursor per account, period. This avoids per-account rate limits, duplicate bandwidth, and concurrent next-batch token confusion.

```ts
class MatrixSyncHub {
  start(signal: AbortSignal): Promise<void>          // begins long-poll loop
  registerRoomHandler(roomId, handler): Disposable   // fan-out by room
  registerEventHandler(roomId, eventType, handler): Disposable  // fan-out by (room, type)
  getNextBatch(): string                             // current cursor
}
```

The hub does the long-poll, parses each `/sync` response, and dispatches each event to registered handlers. Handlers run sequentially per-room (no concurrent dispatch within a room) so a single `GroupSync` never sees out-of-order events. Different rooms dispatch in parallel.

**Ordering contract:**

1. Room handlers are serial per room — events from the same `(roomId, *)` arrive in `/sync` order.
2. Different rooms run in parallel.
3. Global handlers (registered via `registerGlobalEventHandler` for account-wide events like `m.presence`, `m.account_data`) are serial within their own queue.
4. **There is no total-ordering guarantee between global and room-scoped handlers from the same `/sync` batch.** Presence and timeline events from the same batch may dispatch in either order. This is the right tradeoff for v1 because presence is independent of shared state. Any future feature that needs cross-stream ordering (e.g., "presence change implies ACL change") must use a different abstraction — do not silently rely on incidental ordering observed in practice.

**E.2: `GroupSync` (one per joined group, registers handlers with the hub)**

`GroupSync` does NOT own a `/sync` loop. It registers `(roomId, "m.matrix_os.app.*.op")`, `(roomId, "m.matrix_os.app.*.snapshot")`, `(roomId, "m.matrix_os.app_acl")`, and `(roomId, "m.matrix_os.app.*.snapshot_lease")` handlers with the hub at startup. Each instance:

1. **On startup**: opens `state.bin` for each installed app, hydrates Yjs doc, replays `log.jsonl` for any events newer than `last_sync.json.last_event_id`, registers handlers with `MatrixSyncHub`
2. **On inbound `*.op` event**: validates ACL → decodes base64 → `Y.applyUpdate(doc, update)` → fires `onChange` listeners → persists updated state to `state.bin` (atomic write) → appends to `log.jsonl` → updates `last_sync.json`
3. **On inbound `*.snapshot` event**: validates `snapshot_id` matches a complete chunk set → if generation > current → applies snapshot → prunes timeline replay window. Mixed-snapshot chunks are dropped per the atomicity contract in Section C.
4. **On inbound `*.snapshot_lease` event**: updates local lease cache; if local user was the holder and the new lease names another writer, stand down.
5. **On local mutation** (from app or kernel): check own power level vs ACL `write_pl` → `Y.encodeStateAsUpdate(doc, prevStateVector)` → base64 → `matrixClient.sendCustomEvent(roomId, "m.matrix_os.app.{slug}.op", content)` → on success, persist; on failure, append to `queue.jsonl`
6. **On reconnect**: drain `queue.jsonl` in order, oldest first
7. **Snapshot policy**: every 50 ops or 5 minutes (whichever first), if local user holds a valid lease (or can acquire one — see Section C lease protocol), write a fresh snapshot to room state

**Single source of truth:** the Yjs `Y.Doc` instance lives **only** in the gateway-side `GroupSync`. Never in the shell, never in the iframe. Iframes interact with the doc via the bridge described in Section F — `postMessage` calls round-trip to the gateway's `GroupSync` over WebSocket. This prevents drift across multiple open tabs/iframes of the same app, simplifies crash recovery (one persistence path), and matches the existing `app_data` IPC pattern in spec 050.

### F: Bridge Client (`MatrixOS.shared`)

Injected into iframe apps when the app is opened from a group context (`MatrixOS.group !== null`):

```javascript
// Simple key-value (LWW within Y.Map semantics)
MatrixOS.shared.get(key)
MatrixOS.shared.set(key, value)
MatrixOS.shared.delete(key)
MatrixOS.shared.list()
MatrixOS.shared.onChange(callback)  // fires after remote ops apply

// Advanced — direct Yjs access
const doc = MatrixOS.shared.doc()      // Y.Doc instance
const tasks = doc.getArray("tasks")    // Y.Array
const notes = doc.getMap("notes")      // Y.Map
const body  = doc.getText("body")      // Y.Text (rich-text-friendly)

// Group introspection
MatrixOS.group.id            // "!abc123:matrix-os.com"
MatrixOS.group.slug          // "schmidt-family"
MatrixOS.group.name          // "The Schmidt Family"
MatrixOS.group.me            // { handle: "@hamed:matrix-os.com", role: "owner" }
MatrixOS.group.members       // [{ handle, role, online }]
MatrixOS.group.onPresence(callback)
```

The bridge round-trips through `postMessage` to the parent shell (`shell/src/lib/os-bridge.ts`), which forwards to the gateway over the WebSocket described in Section H. **The Yjs `Y.Doc` lives in the gateway's `GroupSync`, not in the shell or iframe.** The iframe gets a thin proxy that ships mutations as serialized Yjs updates and receives `onChange` notifications when the gateway-side doc changes.

For advanced cases (`MatrixOS.shared.doc()` returning a `Y.Doc`), the bridge instantiates a **client-side mirror Y.Doc** in the iframe and keeps it in sync with the gateway's authoritative doc by exchanging Yjs updates over the WebSocket. The mirror is not the source of truth — if the iframe is reloaded, it re-syncs from the gateway's persisted `state.bin`. This pattern is the same as existing Yjs deployments (Hocuspocus, y-websocket): server holds the authoritative doc, clients hold mirrors.

### G: Kernel IPC Tools

New tools in `packages/kernel/src/ipc-server.ts`:

- `create_group(name, member_handles[])` — creates a Matrix room, sets power levels, invites members, scaffolds `~/groups/{slug}/`
- `join_group(invite | room_id)` — accepts a Matrix invite, syncs current room state, downloads app code
- `list_groups()` — reads `~/groups/` and returns slug + name + member count + last activity
- `leave_group(slug)` — leaves Matrix room, archives `~/groups/{slug}/` to `~/groups/_archive/{slug}-{ts}/`
- `share_app(app_slug, group_slug)` — copies `~/apps/{app_slug}` to `~/groups/{group_slug}/apps/{app_slug}`, writes `m.matrix_os.app_acl` state event, sends a `m.matrix_os.app_install` notice to the room timeline so other members' kernels auto-clone
- `group_data(action, group_slug, app_slug, key?, value?)` — read/write/list shared keys from any channel (mirrors existing `app_data` IPC tool)
- `set_app_acl(group_slug, app_slug, policy)` — updates ACL room state event (requires power level)

### H: Auth Matrix

| Boundary | Route / event | Auth method | Authorization |
|---|---|---|---|
| HTTP | `POST /api/groups` | Bearer (Clerk) | Authenticated user |
| HTTP | `POST /api/groups/{slug}/share-app` | Bearer (Clerk) | Group member with `install_pl` |
| HTTP | `GET /api/groups/{slug}` | Bearer (Clerk) | Group member |
| HTTP | `POST /api/groups/{slug}/leave` | Bearer (Clerk) | Group member |
| WS | `/ws/groups/{slug}/{app}` | Bearer (Clerk) on upgrade | Group member; checks ACL `read_pl` |
| Matrix | `m.matrix_os.app.{slug}.op` inbound | Matrix homeserver auth | Sender power level ≥ ACL `write_pl` |
| Matrix | `m.matrix_os.app.{slug}.snapshot` inbound | Matrix homeserver auth | Sender power level ≥ ACL `install_pl` AND sender holds valid `snapshot_lease` matching `snapshot_id` |
| Matrix | `m.matrix_os.app.{slug}.snapshot_lease` inbound | Matrix homeserver auth | Sender power level ≥ ACL `install_pl` |
| Matrix | `m.matrix_os.app_install` inbound | Matrix homeserver auth | Sender power level ≥ ACL `install_pl`; user prompted to accept |
| Matrix | `m.matrix_os.app_acl` inbound | Matrix homeserver auth | Sender power level ≥ 100 (room admin) |
| IPC | `create_group`, `join_group`, `share_app`, etc. | Kernel-internal | Allowlisted in `IPC_TOOL_NAMES` (`packages/kernel/src/options.ts`) |
| Kernel→Gateway | `POST http://localhost:${GATEWAY_PORT}/api/groups/*` | Loopback bearer (existing kernel↔gateway pattern from spec 050) | Same as HTTP route auth above |

**Power level enforcement is doubled:** Matrix homeserver enforces `m.room.power_levels` for state events (snapshot, ACL). The sync engine *also* re-checks the sender's power level for timeline ops before applying — defense in depth, in case a misconfigured homeserver lets through events.

### I: Input Validation

- **Group slug**: `/^[a-z0-9][a-z0-9-]{0,62}$/` (64 chars max, conservative)
- **App slug**: existing `SAFE_SLUG` regex from CLAUDE.md mandatory patterns
- **Member handle**: `/^@[a-z0-9_]{1,32}:[a-z0-9.-]{1,253}$/`
- **Yjs update size**: ≤32KB raw binary per event. Larger updates split via Yjs sub-document or chunked across multiple events with a `chunk_seq` field.
- **Snapshot total size**: ≤256KB across all chunks per app. Apps that exceed this MUST use a sub-document strategy and the kernel logs a warning.
- **All filesystem writes** under `~/groups/` go through `resolveWithinHome` (existing helper) — no escape via `..`
- **Inbound event content**: parsed with Zod 4 schema before any decode/apply
- **Base64 decode**: `Buffer.from(s, "base64")` with explicit length check before passing to Yjs

### J: Error Response Policy

- HTTP errors return generic messages (`"Group not found"`, `"Forbidden"`) — never Matrix homeserver errors, never internal stack traces
- Matrix `errcode` values are logged server-side and translated to generic client messages
- Sync engine errors are logged with structured fields (`group_slug`, `app_slug`, `event_id`, `error_class`) but never bubbled to the iframe app
- App-visible errors via `MatrixOS.shared.onError()` are coarse-grained: `"sync_failed"`, `"acl_denied"`, `"offline"`. The app cannot distinguish "Matrix 401" from "Matrix 503".

## Integration Wiring

### Startup sequence (gateway `server.ts`)

1. Existing services initialize (Postgres, app-db, IPC server, Hono routes)
2. New: `const matrixClient = createMatrixClient({ homeserverUrl, accessToken })` (already exists; verify singleton)
3. New: `const syncHub = new MatrixSyncHub(matrixClient)` — single account-wide /sync loop owner
4. New: `const groupRegistry = new GroupRegistry(homePath)` → `await groupRegistry.scan()` — loads all `manifest.json` files
5. New: for each group → `const sync = new GroupSync({ roomId, matrixClient, syncHub, groupDir })` → `await sync.hydrate()` (loads all `state.bin` files) → `sync.registerHandlers(syncHub)` (handlers fan in from the hub, no per-group long-poll)
6. New: `await syncHub.start(shutdownSignal)` — single long-poll begins after all handlers are registered
7. New: register HTTP routes `/api/groups/*` and WebSocket route `/ws/groups/*` against the existing Hono app, with `groupRegistry` and `matrixClient` injected at construction
8. The kernel subprocess (existing) reaches new functionality via HTTP loopback — it does NOT receive direct references to `groupRegistry` or `MatrixSyncHub`

Crash on hydrate if a `state.bin` file is corrupt: log + quarantine to `state.bin.corrupt-{ts}` + start fresh from snapshot replay. Do NOT silently overwrite.

### Cross-package communication

The kernel runs as a **subprocess of the gateway** (matches existing topology — see `packages/kernel/src/options.ts:83` and the spec 050 `app_data` precedent). Kernel-side IPC tools that need gateway state make loopback HTTP calls to `http://localhost:${GATEWAY_PORT}/api/groups/*`, exactly like the existing `app_data` tool calls `/api/bridge/query`. There is no shared-memory pathway and no DI of gateway objects into the kernel.

- **Kernel → Gateway** (group operations): each kernel IPC tool from Section G calls a corresponding Hono route. `GATEWAY_PORT` is read from env (already set when gateway spawns kernel). All fetches use `AbortSignal.timeout(10000)`. Tool names are added to `IPC_TOOL_NAMES` allowlist in `packages/kernel/src/options.ts:19`.
- **Gateway → Kernel** (agent visibility into remote events): existing IPC channel emits notifications when a relevant Matrix event arrives — for example, `m.matrix_os.app_install` invites prompt the kernel to surface a user-visible accept/decline message via the existing channel adapter. Uses the same `notifyShellHook` path as other proactive notifications.
- **Iframe ↔ Shell**: existing `postMessage` protocol in `shell/src/lib/os-bridge.ts`, extended with `shared:*` and `group:*` action types.
- **Shell ↔ Gateway**: existing WebSocket protocol, plus new `/ws/groups/{slug}/{app}` endpoint that bridges the iframe's mirror Y.Doc to the gateway's authoritative `GroupSync` Y.Doc.
- **Gateway ↔ Matrix homeserver**: HTTPS via the extended `matrix-client.ts` (Section E.1, Phase 1).

No `globalThis`. All gateway-side dependencies (`matrixClient`, `syncHub`, `groupRegistry`) are constructor-injected into routes, WebSocket handlers, and `GroupSync` instances at startup.

### Config injection

- `MATRIX_HOMESERVER_URL` — already in env via existing matrix client wiring
- `MATRIX_ACCESS_TOKEN` — existing
- `GROUP_SYNC_SNAPSHOT_INTERVAL_MS` — defaults to 300000 (5 min)
- `GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD` — defaults to 50
- `GROUP_SYNC_QUEUE_MAX` — defaults to 10000
- `GROUP_SYNC_LOG_RETENTION_DAYS` — defaults to 30

## Failure Modes

### Timeouts

- **Matrix `/sync` long-poll**: 30 second server timeout (`?timeout=30000`) — Matrix protocol standard; reconnect immediately on timeout
- **Outbound op send**: `AbortSignal.timeout(10000)` — 10 second cap, then queue
- **Snapshot upload**: `AbortSignal.timeout(30000)` — 30 second cap, snapshots are larger
- **Initial /sync (cold start)**: `AbortSignal.timeout(60000)` — 60 second cap, then surface "group offline" UI

### Concurrent access

- One `GroupSync` instance per group (singleton). Multiple apps in the same group share the singleton's Yjs docs.
- Yjs is naturally concurrency-safe — concurrent local mutations from multiple iframes apply in any order with the same result.
- `state.bin` writes use the existing atomic write helper (`writeFile` to tmp + `rename`).
- `queue.jsonl` writes use `appendFile` (atomic for single line per POSIX) — never `appendFileSync` (banned in handlers per CLAUDE.md).
- `last_sync.json` updates after `state.bin` to maintain crash recovery invariant: if we crash between them, replay is idempotent.

### Crash recovery

Recovery contract: after crash + restart, the local state must equal `apply(snapshot, all_events_since_snapshot)` for every app in every group. Concretely:

1. On startup, `GroupSync.hydrate()` loads `state.bin` (or starts from empty doc if missing)
2. Reads `last_sync.json.last_event_id`
3. Replays `log.jsonl` from that event onward
4. Connects `/sync` from `last_sync.json.next_batch` token
5. Drains `queue.jsonl` (offline outbound) — Yjs deduplication makes resends safe

### Conflict resolution

Yjs handles automatic merge for all standard operations. Three edge cases need explicit handling:

1. **Concurrent installs of the same app at different versions**: latest `m.matrix_os.app_install` wins (LWW by event ts), other clients prompted to upgrade
2. **Rapid ACL toggle**: Matrix room state is LWW by `(event_type, state_key)`. The sync engine reapplies the latest ACL after every state event before processing the next op. There is a brief window where in-flight ops with the old ACL might still be sent — they are dropped on receipt by other clients.
3. **Member kicked mid-edit**: kicked member's queued ops fail at send time with Matrix `M_FORBIDDEN`; queue.jsonl drops them and surfaces `"acl_denied"` to the app

### Error propagation

- Inbound event apply failure (corrupt update, schema mismatch) → log structured error, increment `group_sync.errors` metric, do NOT crash the sync loop, do NOT silently drop — write the bad event to `~/groups/{slug}/data/{app}/quarantine.jsonl` for inspection
- Outbound send failure → queue + retry with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap)
- After 30 minutes of failed sends → surface persistent UI banner ("Group out of sync"), continue retrying

No bare `catch { return null }`. No empty catch blocks. Webhook-style status codes for HTTP routes only (200/4xx/5xx).

## Resource Management

| Resource | Cap | Eviction policy |
|---|---|---|
| `state.bin` per app | 5 MB | Hard cap; on overrun, prompt user to archive |
| `log.jsonl` per app | 5 MB / 30 days | Whichever first; older events fetchable via Matrix backfill |
| `queue.jsonl` per app | 10000 events | Drop-oldest with logged warning + UI banner |
| In-memory Yjs doc | 100 MB total per group | Per CLAUDE.md mandatory cap; on overrun, evict least-recently-used app's doc and reload from disk on next access |
| `members.cache.json` | 1000 entries | Truncate; truth lives in Matrix room state |
| Quarantine directory | 100 events | Drop-oldest; log warning |
| Snapshot frequency | 50 ops or 5 min | Whichever first; user with `install_pl` only |
| Snapshot total size | 256 KB across chunks | Hard cap; oversize logs warning + skip |

`appendFileSync` and `writeFileSync` are banned in request handlers and the sync loop. All filesystem I/O uses `fs/promises`.

## Phasing

### Phase 0: Spike (1 week, throwaway code)

Per CLAUDE.md "spike before spec" rule:

1. Two real Matrix accounts on `matrix-os.com` (or local synapse)
2. Verify `sendCustomEvent` round-trip latency between two clients (target: p50 < 500ms)
3. Verify Yjs `Y.encodeStateAsUpdate` → base64 → Matrix custom event content → base64 decode → `Y.applyUpdate` round-trips correctly with concurrent edits
4. Verify Matrix `/sync` long-poll behavior (filter by event type, backfill cost, rate limits)
5. Measure: max event content size before Matrix rejects, /sync timeout under load
6. Output: spike report in `specs/062-shared-apps/spike.md` with measured numbers, killed assumptions, go/no-go

**Go/no-go criteria:** if p50 op latency > 2 seconds or Matrix custom event size cap < 16KB, this spec needs major revision.

### Phase 1: Matrix sync layer

Extend `packages/gateway/src/matrix-client.ts` (raw HTTP wrapper only — no subscription/dispatch in this layer; that lives in `MatrixSyncHub`):

- Add `sync({ filter?, since?, timeoutMs? })` for long-poll
- Add `createRoom`, `inviteToRoom`, `kickFromRoom`, `leaveRoom` for room lifecycle
- Add `getRoomState`, `getAllRoomStateEvents`, `setRoomState` for snapshot/ACL/lease state events
- Add `getRoomMembers`, `getPowerLevels`, `setPowerLevels` for membership and ACL inputs
- Translate Matrix `errcode` to typed errors; never leak raw response text
- All new methods get unit tests with a fake Matrix server (msw or in-process)

Build `MatrixSyncHub` (`packages/gateway/src/matrix-sync-hub.ts`) on top, with `registerEventHandler(roomId, eventType, handler)` for room-scoped events and `registerGlobalEventHandler(eventType, handler)` for account-wide events like `m.presence`.

### Phase 2: Group filesystem + IPC tools

- `~/groups/` scaffold + `GroupRegistry` class
- Kernel IPC tools `create_group`, `join_group`, `list_groups`, `leave_group`
- Atomic group manifest writes
- No Yjs yet — manifests only

### Phase 3: Yjs sync engine

- `group-sync.ts` with hydrate / start / stop / applyLocal / applyRemote
- `state.bin` + `log.jsonl` + `queue.jsonl` persistence
- Snapshot replay on cold start
- Vitest unit tests for Yjs merge correctness

### Phase 4: Snapshots in room state

- Snapshot writer (chunked)
- Snapshot reader (cold start optimization)
- Snapshot policy daemon

### Phase 5: Bridge client (`MatrixOS.shared`)

- iframe-side API (`shared.get/set/doc/onChange`)
- Shell-side `postMessage` handler routing to GroupSync
- React hooks (`useSharedDoc`, `useSharedKey`)

### Phase 6: ACL enforcement

- `m.matrix_os.app_acl` state event reader/writer
- Power-level checks on inbound and outbound ops
- `set_app_acl` IPC tool
- ACL UI in app settings panel

### Phase 7: Demo app + onboarding

- Migrate one default app (suggested: shared notes or shared todo) to optionally run in group mode
- Onboarding flow: "Create a family group" → invite member → install shared notes → see live updates
- Playwright screenshot test of the full flow (per `feedback_playwright_screenshots.md`)

## Integration Test Checkpoint

End-to-end test (Vitest + two in-process gateway instances pointed at a local synapse or stub):

1. User A `create_group("test-fam", ["@b:matrix-os.com"])` → room created, manifest written
2. User B receives Matrix invite → `join_group(roomId)` → group dir scaffolded
3. User A `share_app("notes", "test-fam")` → `m.matrix_os.app_install` event → User B's kernel auto-clones notes app
4. User A's iframe calls `MatrixOS.shared.set("note1", "hello")` → op event flows to Matrix → User B's GroupSync applies → User B's iframe `onChange` fires with `"hello"`
5. Disconnect User B → User A makes 5 more edits → reconnect User B → all 5 edits replay in correct order
6. Crash User A mid-edit → restart → state recovers from `state.bin` + replay → no data loss
7. Kick User B (set power level 0 with `read_pl=50`) → User B's WebSocket disconnects, group archived to `_archive/`

Manual Docker verification scenario documented in `specs/062-shared-apps/manual-test.md` (created in Phase 2).

## Non-Goals

- **Federated groups across homeservers** (Matrix supports it; we defer until we have one homeserver running stably)
- **End-to-end encryption** of shared app state (Matrix supports E2EE; CRDT-over-E2EE works but adds key management complexity — separate spec, deferred)
- **Group voice / video** (separate spec, leverage existing voice infra)
- **Shared agent memory** (sharing `~/system/soul.md` content across a group — interesting future spec)
- **Cross-group data flow** (querying one group's data from another — out of scope)
- **Per-key field-level ACLs** (only per-app ACLs; finer granularity is a future enhancement)
- **CRDT-over-CRDT for nested groups** (no group hierarchy in v1)
- **Conflict-free schema migrations** of app data shape (Yjs handles this gracefully but the app code must be backward compatible — author's responsibility, not the platform's)

## Dependencies

**New npm packages:**
- `yjs` (~30KB) — CRDT engine
- `lib0` (Yjs peer dep, ~10KB) — encoding utilities

**Existing packages reused:**
- `matrix-client.ts` (extended in Phase 1)
- `identity.ts` (handle resolution)
- `app-manifest.ts` (app code copy on share)
- `app-fork.ts` `installApp` (reused for cross-group install)
- IPC server in `packages/kernel/src/ipc-server.ts`
- Hono gateway server

**Infrastructure:**
- Working Matrix homeserver (Synapse on platform). Currently: matrix-os.com homeserver provisioning is in scope of spec 041 — this spec assumes that work is complete.
- Postgres NOT required for this spec (shared state lives in Matrix, not Postgres)

## Success Metrics

- A user creates a group, invites another user, shares an app, and both users edit shared state in the same session — measured via Playwright e2e
- Concurrent edits from 3+ members merge without data loss (Yjs property test)
- Cold-start sync of a 30-day-old group with 1000+ ops completes in under 5 seconds (snapshot path)
- Offline edits queued for 1 hour replay correctly on reconnect
- p95 propagation latency from local mutation to remote `onChange` < 1 second on the production homeserver
- Zero `globalThis` usage in the new code (constitution VIII enforcement)
- Zero `appendFileSync` / `writeFileSync` in handlers (CLAUDE.md mandatory pattern)
- 99%+ test coverage on `group-sync.ts` (constitution IX target)

## Open Questions for Spike Phase

1. Does Synapse rate-limit custom events more aggressively than `m.room.message`? If yes, we may need to batch ops.
2. What is the practical max size for a Matrix room state event content field? Spec says 64KB but implementations vary.
3. Are Yjs update binaries deterministic enough that two clients applying the same op set produce byte-identical `state.bin`? If yes, we can hash-compare for sync verification.
4. How does Matrix handle events whose content exceeds the homeserver limit — silent rejection, error code, or chunked delivery?
5. What is the actual round-trip time for a room state event update + /sync echo on the production matrix-os.com Synapse? This calibrates the snapshot lease duration (currently defaulted to 10 minutes — needs measurement).

These questions block implementation, not the spec itself. Spike answers feed into the Phase 1 implementation plan.

## Resolved Decisions

**Snapshot writer model: lightweight single-writer lease (resolved 2026-04-11).**

V1 uses a single-writer lease pattern (Section C `snapshot_lease`), not a full election protocol and not naive eager writing. Rationale:

- **Naive eager is unsafe**: chunked snapshots from concurrent writers can interleave under the same `state_key` namespace, leaving readers with mixed-snapshot chunk sets. Even with `snapshot_id` discrimination on the reader side, eager writers waste room state event budget and create UI churn.
- **Full election (Raft, Paxos, gossip)** is overkill for a problem with at most a handful of writers per group and very loose consistency requirements.
- **Lease pattern** uses Matrix room state LWW as the underlying coordination primitive: writers race to claim the lease, the loser observes the winner on next /sync and stands down. Worst case is one duplicate snapshot before convergence — acceptable because each snapshot is internally consistent (separate `snapshot_id`).

The spike measures lease duration calibration (open question #5). If round-trip is much faster than expected, lease duration drops; if slower, it rises. Ten minutes is the conservative default.

The reader-side rule (reject mixed-snapshot chunk sets, prefer highest generation) is mandatory regardless of writer model and is not deferred — it lives in `GroupSync.applySnapshot()` from Chunk 4.
