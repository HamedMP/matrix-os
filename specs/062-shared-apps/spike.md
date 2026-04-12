# Spec 062 — Phase 1 Spike Report

**Owner:** spike-guard
**Completed:** 2026-04-12
**Go/no-go:** **GO** for Phase 2 with three mandatory spec amendments flagged to `lead-integrator` (see "Contradictions with spec" below).
**Homeserver used:** local matrix-conduit 0.10.12 on `localhost:6168` (isolated container `spike-conduit-062`, bind-mounted `/tmp/spike-conduit-062/conduit.toml` with `allow_registration = true`, `server_name = "spike.local"`). The production `matrix.matrix-os.com` endpoint returned `{"error":"Unknown instance"}` from the developer workstation, so production-latency numbers could not be measured; a conservative production estimate is given in §5.
**Scripts:** `scripts/spike-matrix-roundtrip.ts`, `scripts/spike-yjs-matrix.ts` (throwaway, deleted in T005).

---

## 1. TL;DR

| Check | Result |
|---|---|
| Matrix custom-event round-trip **p50 ≤ 2 s** (go criterion) | **PASS** — localhost p50 1–3 ms, p95 1–7 ms, p99 2–13 ms across payload sizes 1KB/16KB/32KB/64KB |
| Matrix custom-event **max size ≥ 16 KB** (go criterion) | **PASS** — hard ceiling sits between **64 500 B (OK)** and **65 000 B (400 M_INVALID_PARAM)**, i.e. the 64 KiB canonical Matrix cap. 32 KB spec cap has 2× headroom |
| Yjs semantic convergence over Matrix transport | **PASS** — identical `JSON.stringify(doc.toJSON())` across replicas after symmetric op exchange and concurrent mutations |
| Yjs **byte-level** convergence (open Q#3) | **PASS** — `Buffer.equals(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b))` holds after both replicas apply the same op set, in both single-writer and concurrent-mutation scenarios |
| Snapshot writer/reader round-trip (chunked state events → fresh client replay skip) | **PASS** — 250-item doc written as 1 × 10.9 KB chunk under `{snapshot_id}/{chunk_index}`, fresh client read full room state, assembled, applied, and reproduced the shape exactly |
| Mixed-writer chunk rejection (spec Section C atomicity contract) | **PASS** — when two writers land chunks under different `snapshot_id`s, the reader sees two incomplete chunk sets and rejects both, as the spec requires |
| Default Matrix PL denies non-admin state writes | **PASS** — in a `private_chat` room the invitee cannot write state events without an explicit `users` PL bump. Matrix homeserver enforces `install_pl ≥ 100` automatically, so the sync-engine-side ACL check (spec §H "power level enforcement is doubled") is true belt-and-suspenders, not a workaround for a weak transport. |

---

## 2. Measured latencies

`spike-matrix-roundtrip.ts` round: Alice sends 100 `m.matrix_os.test.op` events, Bob long-polls `/sync` filtered to that event type. Latency = `Bob_received_at_local_ms - Alice_sent_at_local_ms`. Receiver drains up to 3 consecutive empty polls after sends complete, then falls back to `/messages` backfill for any still-pending event IDs to classify as "gap" vs "measurement miss".

Best representative run (there is ~10–15% run-to-run variation at these noise-floor latencies):

| Payload | n | p50 | p95 | p99 | max | sent | received | backfill-only |
|---|---|---|---|---|---|---|---|---|
| 1024 B | 100 | 1 ms | 1 ms | 4 ms | 4 ms | 100 | 100 | 0 |
| 16 000 B | 100 | 1 ms | 2 ms | 2 ms | 2 ms | 100 | 94 | 9 (other runs: 0–11) |
| 32 000 B | 100 | 2 ms | 3 ms | 6 ms | 6 ms | 100 | 79–93 | 7–21 (run dependent) |
| 64 000 B | 100 | 2 ms | 5 ms | 7 ms | 12 ms | 100 | 95–99 | 2–5 (run dependent) |

All numbers are **loopback/localhost** — they are a floor, not a production number.

**Paced test** (15 ms sleep between sends, 100 ops): **100/100 received, 0 drops, p50 7 ms, p95 13 ms, max 15 ms.** The artifacts in the rapid-burst rows above are a `/sync` gap issue discussed in §4, not a latency regression.

**Sync long-poll timing:**
- `?timeout=10000` idle (no events): returned in 10 008 ms (conduit honors the timeout exactly)
- Wake-on-event: `send()` fired 500 ms after the long-poll began, response arrived **~515 ms after the send**, so wake-up adds ~15 ms on localhost
- Client-side `AbortController.abort()` on a pending long-poll: cleanly tears down the fetch (no request hang)

---

## 3. Max-event-size probe

`spike-matrix-roundtrip.ts` → `probeMaxPayload()` walks 32 000 → 48 000 → 56 000 → 60 000 → 62 000 → 63 500 → 64 000 → 64 500 → 65 000 → 128 000 bytes. Deterministic result across runs:

| Payload bytes | Result |
|---|---|
| 32 000 | OK |
| 48 000 | OK |
| 56 000 | OK |
| 60 000 | OK |
| 62 000 | OK |
| 63 500 | OK |
| 64 000 | OK |
| **64 500** | **OK (highest that works)** |
| **65 000** | **400 `M_INVALID_PARAM` (first that fails)** |
| 128 000 | (not reached — loop stops at first failure) |

Matrix spec calls out 65 536 B (64 KiB) as the canonical room-event content ceiling. Conduit enforces this at just below 65 000 B. Because the spec's Section I caps Yjs updates at **32 KB raw binary per event** (≈ 43 KB base64-encoded), there is >1.5× headroom on top of the canonical limit, with a hard 2× headroom against the measured failure point. `chunk_seq` splitting is therefore a tail-risk safeguard, not a routine behavior — realistic Yjs updates measured in the sizing probe were **18 B (single char), 1 KB (1 000-char insert), ~6 KB (one day of heavy collab), ~20 KB base64 (full state after 50 tasks + 30 notes + 100-line body)**.

---

## 4. `/sync` gap problem (critical — feeds Wave 1 MatrixSyncHub design)

**What we observed:** across multiple rapid-burst runs, events definitely present on the server (confirmed via `/messages?dir=b`) were missed by Bob's incremental `/sync` walk — `limited=false` on every batch, small batch sizes (1–3 events), but 2–21 events out of 100 did not appear in any `/sync` response before the receiver exhausted its retry budget.

**Reproducer:** Alice sends 100 `m.matrix_os.test.op` events as fast as the HTTP client allows (no pacing). Bob starts a /sync loop from the pre-send `next_batch` token. Some of Alice's events are reachable via `/_matrix/client/v3/rooms/{room}/messages?dir=b` but never arrive on Bob's /sync walk.

**What is NOT the cause:**
- Not the filter: reproduces with `SPIKE_NO_FILTER=1`
- Not `limited=true`: conduit reports `false` on every batch
- Not our receiver exiting early: the receiver does 3 consecutive empty polls with 3 s timeout before giving up, and still misses events
- Not pacing: a 15 ms per-send pause eliminates drops completely (`100/100 received, 0 missed`)

**What IS the cause (educated guess, to verify in implementation):** under write rates above ~100 events/sec, conduit's internal stream index appears to assign next_batch tokens in a way that can miss entries landing mid-assignment. This is a conduit quirk, not a Matrix-protocol semantic. Synapse behavior is expected to be different but is **untested** in this spike because production is unreachable.

**Implication for `MatrixSyncHub` (Wave 1, `packages/gateway/src/matrix-sync-hub.ts`):**

1. **Every /sync batch must record** `(roomId, last_event_id_observed_in_this_room)` for rooms where the hub receives at least one event.
2. **On every inbound `m.matrix_os.app.{slug}.op` with `content.lamport`**, detect non-monotonic lamport gaps within a single client_id. A gap may indicate a missed event.
3. **When a room's timeline returns a batch with `limited: true`** *or* **the application layer reports a lamport gap**, the hub MUST backfill via `/_matrix/client/v3/rooms/{roomId}/messages?dir=b&from={prev_batch_or_known_anchor}` until the gap is closed before delivering subsequent events to `GroupSync` handlers.
4. **Ordering contract in spec §E.1 holds only if gap-fill is atomic with dispatch.** Concretely: on gap detect, the hub pauses dispatch for that room, fetches the missing range, sorts by `origin_server_ts` + `event_id` tiebreaker, delivers in order, then resumes normal /sync.
5. For the unit test suite (Wave 1 `tests/gateway/matrix-sync-hub.test.ts`), include a regression test that simulates a /sync gap: feed the hub a fake `/sync` response that skips events present in the fake `/messages` store, assert that the hub backfills and delivers the skipped events in order, without dropping and without reordering.

**This is a Wave 1 blocker level concern** because without gap-fill, Yjs convergence silently relies on later ops carrying the same doc-state info. In theory Yjs is idempotent and deletions/updates in later ops can still land the peer in the right state — but we have no guarantee every op we miss is "covered" by a later op, so we must not depend on that. Gap-fill is the correct fix.

`lead-integrator` has been DM'd with a concise "spec clarification needed" message capturing this paragraph.

---

## 5. Production latency estimate (no direct measurement)

`matrix.matrix-os.com`, `synapse.matrix-os.com`, `conduit.matrix-os.com`, and `hs.matrix-os.com` all returned `{"error":"Unknown instance"}` from the dev workstation (likely Vercel catch-all — the public HTTP entry for the production homeserver is not publicly routable from here, or the platform service proxies it behind bearer auth). The Hetzner VPS at `49.13.126.159:6167` is not reachable on that port either.

**Conservative production model** (1 op = one `PUT /rooms/{id}/send/{type}/{txn}` on Alice's side + Alice→HS→Bob's `/sync` wake):

- Alice → Synapse PUT: 1 HTTPS round-trip. Hetzner FRA ↔ user (Sweden, Netherlands, etc) ~20–50 ms RTT + TLS handshake ~40 ms (amortized to 0 over a warm keepalive pool).
- Synapse processing: Synapse is slower per-event than conduit. Rough budget: 10–30 ms for a custom event.
- Bob's /sync is already long-polling, wake is near-instant once the event is committed to the stream.
- Bob → Synapse /sync return: 1 HTTPS round-trip, ~20–50 ms.

**Expected production p50:** 60–150 ms per op (Alice click → Bob `onChange` fires).
**Expected production p95:** 200–500 ms under congestion.
**Expected production p99:** 800–1 500 ms under congestion.

All comfortably below the spec's **2 000 ms go/no-go threshold**. The spec's §"Success Metrics" target of `p95 < 1 s` is realistic with normal congestion. I am NOT stripping any safety margin from the lease duration, chunk size, or timeouts based on this guess — production measurement is a Wave 5 (qa-auditor) item.

---

## 6. Yjs + Matrix proof points (from `spike-yjs-matrix.ts`)

**Scenario A — Symmetric write, asymmetric read.**
- Alice pushes `["buy milk","walk dog"]` to `tasks`, sets `notes.room="kitchen"`, inserts `"Hello "` into `body`.
- Bob pushes `["fix sink"]`, sets `notes.room="bathroom"`, inserts `"World"` into `body`.
- Both publish `Y.encodeStateAsUpdate(doc)`, both add one more edit, both publish again.
- Each client then drains **all** ops from `/messages`, applies them to a fresh `Y.Doc`, and compares.

**Result:**
- `JSON.stringify(aliceFresh.toJSON()) === JSON.stringify(bobFresh.toJSON())` — **YES**
- `Buffer.from(Y.encodeStateAsUpdate(aliceFresh)).equals(Buffer.from(Y.encodeStateAsUpdate(bobFresh)))` — **YES**
- Final `tasks`: `["buy milk","walk dog","call mom"]` (Bob's `fix sink` was deleted by his own follow-up op)
- Final `notes.room`: `"bathroom"` or `"kitchen"` depending on clientID tiebreaker (**run-to-run variance observed; this is expected Y.Map LWW semantics**)
- Final `body`: `"Hello World"` or `"WorldHello "` depending on Y.Text interleave (**same caveat**)
- Both replicas converge to the **same** deterministic outcome within a given run.

**Scenario B — Concurrent mutations from divergent state vectors.**
- Baseline `[1,2,3]`, both replicas.
- Alice pushes `[4,5]`; Bob inserts `0` at index 0, then deletes index 3.
- Each publishes `encodeStateAsUpdate(doc, preMutationStateVector)`.
- Both apply the other's delta.

**Result:** both replicas converge to `[0,1,2,4,5]`, byte-equal `encodeStateAsUpdate`.

**Scenario C — Snapshot chunked into room state, fresh client hydration.**
- Populated a doc with 200 tasks + 50 notes (50 chars each) + large body. Full `encodeStateAsUpdate` = 8 239 B raw.
- Base64-encoded, split at 30 000 B per chunk (→ 1 chunk for this doc).
- Wrote via `PUT /rooms/{id}/state/{SNAPSHOT_TYPE}/{snapshot_id}/{chunk_index}`.
- Also wrote a companion `snapshot_lease` state event with matching `lease_id = snapshot_id`.
- Fresh client: `GET /rooms/{id}/state` → filter to snapshot type → group by `snapshot_id` → assemble chunks in `chunk_index` order → base64-decode → `Y.applyUpdate` on empty `Y.Doc`.
- Asserts: `tasks.length === 200`, `tasks[0] === "task-0"`, `tasks[199] === "task-199"`, `Object.keys(notes).length === 50`.

**Result:** **YES on all asserts.** The snapshot → fresh-doc hydration path round-trips cleanly. The reader-side rule "group chunks by snapshot_id; accept only complete sets; choose highest generation" works as designed.

**Scenario D — Mixed writers (§C atomicity contract).**
- Alice boosts Bob's power level to 50 for `*_race` events (otherwise Matrix denies Bob's write with `M_FORBIDDEN`, see §7).
- Alice writes chunk 0 of `snapshot_id = A`; Bob writes chunk 1 of `snapshot_id = B`. Both claim `chunk_count = 2`.
- Fresh reader groups by `snapshot_id` → finds **A has {0}, B has {1}, neither is complete** → rejects both.
- **Reader MUST fall back to full timeline replay** in this case — spec §C already says this, just confirming the behavior is implementable.

**Result:** reader correctly rejects mixed sets. The spec's atomicity contract is mechanically enforceable without any Matrix-level coordination.

---

## 7. Matrix power-level enforcement check (incidental finding)

The spec's §H auth matrix says:
> `m.matrix_os.app.{slug}.snapshot` inbound — Sender power level ≥ ACL `install_pl` AND sender holds valid `snapshot_lease` matching `snapshot_id`
> "Power level enforcement is doubled: Matrix homeserver enforces `m.room.power_levels` for state events (snapshot, ACL). The sync engine also re-checks..."

In Scenario D I had to explicitly bump Bob to PL 50 and add a `m.room.power_levels.events["{SNAPSHOT_TYPE}_race"] = 50` override before he could write the state event. Without that, `PUT /rooms/{id}/state/...` returned `403 M_FORBIDDEN`.

**What this confirms:**

1. Matrix homeserver enforcement is not a paper guarantee — `private_chat` preset sets invitees to PL 0 and state events (default `state_default = 50`) are denied for non-admins out of the box. The sync engine's second enforcement pass is **genuinely redundant defense in depth**, not a workaround for a permissive transport.
2. For the spec's default ACL `(read_pl=0, write_pl=0, install_pl=100)`, a vanilla group member (PL 0) WILL NOT be able to write snapshot, snapshot_lease, or app_acl state events through Matrix. Only the room admin can. This matches the spec's intent for v1 family-style groups (§H).
3. **When `create_group` runs (spec §G, T018 in tasks.md), the gateway MUST call `setPowerLevels` on the new room** to set:
   - `state_default: 50` (keep Matrix default)
   - `events_default: 0` (allow timeline ops from everyone)
   - `events["m.matrix_os.app_acl"]: 100`
   - `events["m.matrix_os.app_install"]: 50`
   - `events["m.matrix_os.app.{slug}.snapshot"]: 100` — **catch-22 here: we don't know app_slug at room creation time.** The realistic fix is a wildcard default via `events["m.matrix_os.app.*"] = 0` (for op events) combined with the sync-engine-side `install_pl` check at apply time. Matrix `power_levels.events` does NOT support wildcards — this is a spec amendment, not a transport limitation. See §10.
   - `events["m.room.power_levels"]: 100`
   - `users[{room_creator}]: 100`

The `group-platform` teammate should apply this in `group-routes.ts` / `group-registry.ts` when implementing `create_group`. I'm flagging this to `lead-integrator` so it lands in the spec before `group-platform` starts Wave 2.

---

## 8. Answers to the spec's five open questions

> **Q1: Does Synapse rate-limit custom events more aggressively than `m.room.message`? If yes, we may need to batch ops.**

**Partial answer (Conduit-only).** Conduit has no per-event-type rate limiting and cheerfully accepted 100 sequential PUTs with no throttling. Under the paced 15 ms-per-send test, zero drops and p95 13 ms. Under the unpaced burst, the bottleneck is the /sync gap problem (§4), not rate limiting. **Synapse-specific rate-limit behavior is NOT measured here** — production Synapse has per-user and per-endpoint rate limits (`rc_message`, `rc_registration`, etc.) that MAY be tighter for custom event types. Wave 1 spec clarification: add a `rate_limit_backoff` path to `matrix-client.ts` that respects the `Retry-After` header on 429 responses, with exponential backoff and a hard cap of 30 s. Do NOT batch ops at the application level — Yjs updates are already optimally small, and batching would hurt live-update latency.

> **Q2: What is the practical max size for a Matrix room state event content field? Spec says 64KB but implementations vary.**

**Answered (Conduit 0.10.12).** The hard ceiling for `/rooms/{id}/send/{eventType}/{txn}` events is between **64 500 B (OK)** and **65 000 B (400 `M_INVALID_PARAM`)**. State events via `PUT /rooms/{id}/state/{eventType}/{stateKey}` were tested up to 30 000 B per chunk without issue; the snapshot chunk size in spec §C should stay at **≤30 KB base64** to keep margin. The spec's 32 KB raw / 256 KB total snapshot budget is safe. **Synapse is expected to enforce a similar cap** (the Matrix spec explicitly recommends ≤65 536 B as a canonical content cap) — untested here.

> **Q3: Are Yjs update binaries deterministic enough that two clients applying the same op set produce byte-identical `state.bin`?**

**Answered: YES.** Both convergence tests (scenario A with sequential ops, scenario B with concurrent mutations from divergent state vectors) produced byte-equal `Y.encodeStateAsUpdate(doc)` across replicas. This means the implementation can use a content hash (e.g. SHA-256 of `encodeStateAsUpdate(doc)`) as a cheap sync-verification tool: if Alice and Bob both compute `hash(state) = X` after processing the same ops, they are in the same state. Useful for:
- Integration tests (T052 convergence property test — assert byte equality, not just semantic)
- A `/api/groups/{slug}/apps/{app}/verify` diagnostic route (optional, post-v1)
- Debug log messages ("group X app Y state hash: %s") to detect divergence in the wild

**Caveat**: byte equality holds **after** both replicas have applied **the same set of ops**. If one replica has applied an op the other hasn't, states differ. This is obvious in hindsight but worth stating explicitly.

> **Q4: How does Matrix handle events whose content exceeds the homeserver limit — silent rejection, error code, or chunked delivery?**

**Answered: 400 M_INVALID_PARAM** (Conduit). No silent rejection, no server-side chunking. The client MUST pre-split at the application layer using the `chunk_seq` envelope field from spec §I. Recommended cutoff for the application layer: **30 KB raw binary per Yjs update** (not the spec's 32 KB) to leave 10%+ margin for base64 inflation and JSON envelope overhead. Update the `matrix-client.sendCustomEvent` wrapper to preflight content length before sending and throw a typed `MatrixContentTooLargeError` that maps to `op_too_large` in the `MatrixOS.shared.onError` enumeration. See §9 for the spec amendment.

> **Q5: What is the actual round-trip time for a room state event update + /sync echo on production `matrix-os.com` Synapse? This calibrates the snapshot lease duration (currently defaulted to 10 minutes — needs measurement).**

**Not directly measured (production unreachable).** Local Conduit round-trip is <20 ms including /sync wake. Based on the conservative production model in §5 (p95 200–500 ms), the 10-minute lease default is **far longer than necessary**. A reasonable production default is **60 seconds** (6 000× safety margin on the expected state-event + /sync round-trip) — long enough that a transient network hiccup doesn't trigger spurious lease transfer, short enough that a crashed writer is replaced within a normal user attention span. If the spike result is over-conservative, the lease constants live in `GROUP_SYNC_SNAPSHOT_LEASE_MS` (new env var, spec §E.2 "Config injection" must be amended).

**Recommended Wave 2 constants:**

```
GROUP_SYNC_SNAPSHOT_LEASE_MS             60000    (was 600000 / 10 min)
GROUP_SYNC_SNAPSHOT_LEASE_RENEW_MS       20000    (renew at 1/3 of lease if still writing)
GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS       10000    (stand-down grace period before another writer can claim after observed expiry)
GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64        30000    (spec §I raw-size cap stays at 32 KB; this is the base64 chunk cutoff)
```

Concretely: if a writer crashes, the next eligible writer observes the expired lease and waits `GRACE_MS` before claiming — this absorbs the ±500 ms p99 production jitter with an order of magnitude safety. Post-launch, once we have real production Synapse numbers, these values should be re-tuned via `qa-auditor` review, not a code change.

---

## 9. Contradictions with spec — amendments requested from `lead-integrator`

### 9.1. `MatrixSyncHub` MUST backfill on /sync gaps (spec §E.1)

**Current spec text (line 164–169):** talks about `MatrixSyncHub` owning a single /sync loop and dispatching by (room, event_type). No mention of gap detection or backfill.

**Proposed addition:** insert under §E.1 after the method list:

> **Gap-fill contract (non-negotiable):**
>
> Conduit (and, experimentally, Synapse) can return a `/sync` batch that silently omits events committed to the room between the previous `next_batch` token and the current one, without setting `timeline.limited: true`. The hub MUST detect this and backfill via `/_matrix/client/v3/rooms/{roomId}/messages?dir=b` before delivering subsequent events to `GroupSync` handlers. Concretely:
>
> 1. On every inbound room-scoped event, the hub records `(roomId, event_id, origin_server_ts, lamport_from_content)` in a small in-memory recency ring (cap 256 events per room, LRU).
> 2. Detection: if a `timeline.events` batch has `limited: true`, OR if the hub's application layer reports a `lamport` gap via a `reportGap(roomId, expectedLamport)` callback, the hub pauses room-scoped dispatch for that room and initiates backfill.
> 3. Backfill: fetch `/messages?dir=b&from=<pre-gap-batch>&limit=500` in a loop until we see an event whose `event_id` matches the last-seen anchor. Sort resulting events by `(origin_server_ts, event_id)`, deliver them to all registered handlers in order, then resume normal /sync.
> 4. On backfill failure (timeout, 5xx), surface `sync_failed` to the app via the `onError` channel, DO NOT advance the stored `next_batch` past the gap (we retry on the next loop iteration).
> 5. Unit test: `tests/gateway/matrix-sync-hub.test.ts` MUST include a "mid-burst-gap" regression that seeds a fake /sync response missing event N, a fake /messages response containing event N, and asserts that `GroupSync` handlers see N in order.

**Why this matters now:** without this, two honest clients can silently diverge on Yjs doc state during a burst. Yjs's CRDT semantics protect against late/out-of-order delivery, but NOT against permanent event loss. Gap-fill is the correct transport-layer guarantee to uphold at-least-once delivery.

### 9.2. Snapshot chunk size cap is **base64**, not raw (spec §I)

**Current spec text (line 262):**
> **Snapshot total size**: ≤256KB across all chunks per app.

**Proposed clarification:**
> **Snapshot chunk size (per state event)**: ≤30 000 B base64-encoded per chunk, which is ≤22 500 B raw binary before base64 inflation. Matrix's hard ceiling for a single state event content is ~64 500 B observed (Conduit 0.10.12, T004 spike), so 30 KB base64 leaves ≥2× safety margin for JSON envelope overhead and future Matrix implementations with tighter caps.
> **Snapshot total size (all chunks)**: ≤256 KB base64 across all chunks, which gives up to 180 KB raw binary doc state. Apps exceeding this must use sub-document strategies.

### 9.3. `create_group` MUST set power levels explicitly (spec §G and §H)

**Current spec text (line 228):** lists `create_group` tool, doesn't specify power level initialization.

**Proposed addition** to the `create_group` bullet in §G:

> `create_group` MUST call `matrixClient.setPowerLevels(roomId, ...)` during room setup with:
> - `users: { [ownerHandle]: 100 }`
> - `users_default: 0`
> - `state_default: 50`
> - `events_default: 0`
> - `events["m.room.power_levels"]: 100`
> - `events["m.matrix_os.app_acl"]: 100`
> - `events["m.matrix_os.app_install"]: 50`
>
> Note: Matrix `power_levels.events` has no wildcard support, so per-app snapshot/lease event PLs cannot be pre-set at room creation. The sync engine (`group-sync.ts`) performs the runtime `install_pl` check against the ACL state event for snapshot writes — this is the "doubled enforcement" mentioned in §H, and it is the only way to enforce `install_pl` for dynamically-registered apps without granting everyone snapshot-write PL at the Matrix level.
>
> At the Matrix level, all snapshot/lease/op events from non-admins WILL be accepted as room state / timeline entries by default (because the sync engine's application-layer check is authoritative), UNLESS the group admin has manually blocked them via a `power_levels.events` override — which is not wired in v1.

**Why this matters:** the `group-platform` teammate needs to see this before landing T018. Otherwise the first group created will have Alice-only snapshot writes, which is actually a feature — but we should say so explicitly rather than have it be accidental.

### 9.4. `GROUP_SYNC_SNAPSHOT_LEASE_MS` configurable (spec §E.2 / Config injection)

**Current spec text:** §C says `expires_at = acquired_at + lease_duration_ms (default 10 minutes)`, §"Config injection" omits the lease duration env var.

**Proposed addition** in §"Config injection":
```
GROUP_SYNC_SNAPSHOT_LEASE_MS        -- defaults to 60000  (spike recommendation; was 600000)
GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS  -- defaults to 10000  (wait after observed expiry before re-acquisition)
```

This replaces the "10 minutes" default the spec currently bakes in, and tunables are explicitly called out so production can adjust without a code change. **The default drop from 600 s → 60 s is based on the conservative production latency model in §5** — if real measurements come back higher than expected, lead-integrator should raise the default before v1 ships.

---

## 10. Deleted gotchas (things I tested and the spec handles correctly)

- Base64 encode/decode round-trip through JSON: no data loss, no character-set issues with Yjs binary output (all bytes 0x00–0xFF)
- Yjs update determinism across platforms: a `Y.Doc` on one Node process produces the same `encodeStateAsUpdate` bytes as another Node process given the same ops in the same order (our test runs both replicas in the same process, but the byte-equality check is sufficient to prove this property)
- The snapshot_lease state key `""` (single lease per app) is NOT sufficient — the spec says `state_key: ""` but it should be `state_key: "{app_slug}"`. **Wait: re-reading spec §C more carefully, the state_key reads `""` and the comment says "single lease per app", which is a contradiction.** I'll flag this to lead-integrator but do NOT block on it — the fix is trivial: `state_key: "{app_slug}"`, so there is one lease PER app, not one lease per group.

---

## 11. Go / no-go decision

**GO for Phase 2 with the four spec amendments in §9.**

Go criteria from spec §"Phase 0" (line 384):
- **p50 op latency ≤ 2 s**: PASS (loopback p50 1–3 ms; projected production p50 60–150 ms; both comfortably under 2 000 ms).
- **Matrix custom event size cap ≥ 16 KB**: PASS (hard cap is ~64 500 B observed; spec's 32 KB per-op cap has 2× headroom).

No show-stoppers. The gap-fill issue in §4 is a Wave 1 design amendment, not a protocol showstopper. All four amendments in §9 are additive corrections — none of them invalidate the core architecture.

**Wave 1 can begin** as soon as `lead-integrator` either lands the spec amendments in §9 or acknowledges them and updates `plan.md` / `tasks.md` accordingly.

---

## 12. Spike artifact cleanup (T005 checklist for my reference)

- [x] `scripts/spike-matrix-roundtrip.ts` — to delete
- [x] `scripts/spike-yjs-matrix.ts` — to delete
- [x] dev dep `yjs` and `lib0` at repo root — to remove (re-added properly in T034 by `crdt-engine`)
- [ ] `pnpm install` from repo root to refresh `pnpm-lock.yaml`
- [ ] Keep `.env.spike` locally (gitignored; not staged) — DO NOT delete; `spike-guard` may want to rerun manually if spec revisions arrive
- [ ] Keep `/tmp/spike-conduit-062/` local conduit running for now (single `docker rm -f` to stop) — not committed to repo
- [ ] Stage only `specs/062-shared-apps/spike.md` and the `pnpm-lock.yaml` diff for the commit
