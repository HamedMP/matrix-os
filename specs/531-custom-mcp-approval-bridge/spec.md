# Custom MCP per-call approval bridge (B3, implementation draft)

## Status and dependency

This is the test-first contract and implementation scope for a stacked change on
the live-Run proxy provenance prerequisite (#1925), itself stacked on
`codex/eng25-claude-scoped-mcp` at
`f7858c60654e5862cf4736afe4743964987e17e8` (#1910). The positive path
remains a draft pending review and affected-runtime acceptance.
The external fleet recovery plan is
`2026-09-24/matrix-release-regression/specs/530-ai-integrations-recovery/plan.md`.

The supported positive surface is a personal-owner canonical Claude Chat Run in
`supervised` / CLI `default` permission mode. A local, isolated Claude Code
2.1.280 fixture showed `can_use_tool` delivers the exact tool name/input and
`updatedInput` reaches the MCP tool; it used fixture-selected allow/deny and did
not prove a real user decision. The fixture and its limits are recorded in the
ignored local evidence directory `B3-claude-approval-spike`. Review/plan stays
discovery-only. `always_ask` remains explicit, fail-closed unsupported for
Claude `auto_accept_edits`, `auto`, and `full_access`, and for Codex and Hermes
until their exact native transport and run provenance are proven separately.
An `allow` policy may run through its existing scoped call path in supported
write modes, but must still pass current broker server/tool/projection checks.

## Existing authority and the first wrong boundary

`custom_mcp_servers.revision` is an integer in Platform Postgres, incremented
under an optimistic `WHERE revision = :baseRevision` update. The VPS projection
stores the same revision and a second tool policy. The broker currently allows
an `always_ask` call when its caller supplies `approvalGranted: true` after
these policy checks. A run-scoped Gateway bearer already rejects that Boolean
in #1910, but the Platform broker's Boolean is still not an authenticated user
decision. No native callback or MCP tool argument may manufacture that claim.

The B1 registry stores `actorId`, `runId`, `scope`, and expiry, while `resolve`
exposes only the actor. B3 needs a separate server-side `resolveRunContext`
lookup to expose the exact live `actorId`/`runId`/`scope` without expanding the
bearer's path permissions. B2 owns a disjoint `integration_read` scope and
read-only integration call; these changes must not alias its scope to the B3
`call` grant. The Gateway approval path must never accept a caller-provided
run ID or actor header as provenance.

Platform mints a short-lived, domain-separated HMAC approval proof only after
its authoritative resolver has verified a Clerk session or platform sync JWT
for the exact canonical approval POST. It binds owner handle, actor, chat,
Run, approval ID, per-call decision, client request ID, canonical request-body
digest, expiry, and nonce. Platform strips any caller-supplied proof header and
overwrites it. Gateway carries that proof through the active canonical Run;
the machine bearer alone cannot mint or submit approval. The internal decision
route verifies the tuple and current expiry again inside the locked decision
transaction. Preview, mobile-session, and static-route identity sources cannot
mint proof. A missing or unverifiable Platform proof cannot grant `always_ask`.

## Additive persistence and resource bounds

Platform Postgres/Kysely adds two owner-scoped tables; it does not reuse the
24-hour *server onboarding* pending expiry as a tool approval timeout:

* `custom_mcp_run_leases`: random lease epoch ID, internal owner UUID, Clerk
  actor ID, canonical Chat run ID, positive segment generation, `active/revoked` state, expiry, created/updated
  timestamps; at most one live owner/run identity. Register from the trusted
  Gateway Chat launch only after checking that the canonical Run is current and
  active, idempotently only for the same actor and active lease. A revoked lease
  row cannot transition back to active.
* `custom_mcp_tool_approvals`: random challenge ID, owner UUID, actor ID,
  run ID, lease epoch ID **and captured segment generation**, server UUID, authoritative server revision, tool name, canonical
  argument SHA-256 digest, `pending/approved/denied/consumed/revoked` state,
  expiry, hash of a random 256-bit receipt, and transition timestamps. The raw
  receipt is returned once to the trusted Gateway callback, never stored,
  logged, or included in a public read. Foreign owners see a generic miss.

Use a transaction with the lease row locked for reserve/decision/revoke/consume
and a conditional status transition in the write. Lease registration also locks
the owner row (or one equivalent owner-scoped lock) before counting/inserting:
locking only distinct new lease rows does not serialize the 128-per-owner cap.
Cap at 16 live approval challenges per Run and 128 live Run leases per owner;
fail closed at capacity.
Pending approval lifetime is at most 10 minutes and no longer than its Run
lease. Challenge rows may be pruned 24 hours after terminal state; lease
tombstones remain at least until the last bound challenge is gone and all
scoped bearers from that lease have expired. A later registration bearing the
same run ID requires a currently active canonical Chat Run and creates a new
random lease epoch, so it cannot match an old receipt even if a tombstone was
pruned. The canonical Chat repository never intentionally reuses Run IDs.
Use indexed, capped-batch wall-clock sweeps plus opportunistic expiry checks on
reads and writes; cleanup work itself must be bounded and recurring. Bound
database acquisition and query execution, not only the caller's wait:
`Promise.race` around a query is insufficient when the underlying pool remains
busy at shutdown. Reuse existing owned maintenance machinery where it can
provide a real deadline without another unbounded timer or pool. B3 borrows
the existing PlatformDb/Kysely resource: its cleanup closes only timers and
registries it owns; the existing Platform shutdown remains the sole owner of
`PlatformDb.destroy()` and its shared pool. A sweep or process restart must
not revive a receipt. A
pending challenge can be recreated only after a new live native callback and
current policy validation. Repeated reserve for the same callback is
idempotent under a unique owner/run/native-request key, not a second prompt.

The digest is `SHA-256("matrix-custom-mcp-args:v1\\0" + canonical-json(args))`.
Canonical JSON sorts object keys recursively, preserves array order, accepts
only finite JSON values, and rejects excessive depth/bytes. The parsed object
used for digest is the same object forwarded to the remote MCP server. The
opaque receipt is a separate local control field and is excluded from the
digest and remote JSON-RPC arguments. Duplicate JSON object keys collapse in
the parser before both hashing and dispatch. Any changed argument, actor,
run, server, revision, tool, expiry, or consumed receipt fails closed.

At reserve and consume, verify the authoritative server remains ready and
enabled, the selected tool remains enabled, the current revision matches the
challenge, and the local projection still matches that revision and does not
weaken `always_ask`. Unknown/missing policy is a denial. Consume performs the
receipt and lease transition atomically immediately before the remote call;
one concurrent request wins. The receipt is spent even if the remote call
later fails or times out, preventing duplicate side effects.

Steering deactivates the old CLI segment and scoped bearer immediately, then
waits for a machine-authorized transaction that revokes all pending and
approved challenges in that generation and advances the active lease's
generation. The next CLI segment captures the returned generation before
launch; callbacks from the prior segment keep their old captured generation
and cannot reserve, decide, or consume afterward. If clear fails, the old
lease receives a best-effort terminal revoke and the resumed segment receives
discovery-only access. Cancellation or early event-stream close during the
barrier terminally revokes the lease and never launches another segment.

## Auth matrix and dispatch path

| Caller | Discovery | `allow` call | Reserve/decision | `always_ask` dispatch |
| --- | --- | --- | --- | --- |
| Live scoped Claude Run bearer (`discovery`) | yes | no | no | no |
| Live scoped Claude Run bearer (`call`) | yes | after broker policy | no | only with one-use receipt supplied by trusted callback |
| Authenticated Chat owner via canonical approval submit | no new MCP grant | no new MCP grant | decide its own current pending Run challenge only | no direct dispatch |
| Gateway Chat service → Platform internal approval route | internal only | internal only | yes, with server-held machine authority and live actor/run binding | no raw Boolean |
| Generic browser Gateway proxy or model-supplied header/Boolean | existing user policy routes only | no approval escalation | no | no |
| Preview/foreign owner/revoked Run | no scoped capability | no | no | no |

Reserve and decision endpoints belong under a separate Platform internal route,
not beneath the Gateway's `/api/mcp-servers/*` proxy. They require server-side
machine authority and derive the Platform owner from the authenticated machine
handle. The scoped Run bearer cannot reach them even with a forged body or
header. The canonical Chat approval route authenticates the real owner and
checks the active Run and exact pending challenge before invoking the adapter.
The adapter submits the decision to Platform over the internal channel; the
model never supplies the decision. `approve_for_session` cannot substitute for
a per-call `always_ask` approval.

For supervised/default Claude, remove `call_custom_mcp_tool` from automatic
permission allowlists while retaining discovery. On exact native
`can_use_tool` for that tool, ask the broker for current policy: `allow`
responds native allow immediately with unchanged input (no user prompt);
`always_ask` reserves a challenge, emits a canonical approval event showing
the selected server/tool and bounded exact argument preview, then waits for
authenticated Chat submit. Approve returns a one-use receipt in
`updatedInput`; deny, timeout, native cancel, Run cancel, or shutdown answers
native deny. If arguments cannot be safely shown within the bounded preview,
fail closed instead of presenting a misleading generic approval. The MCP
wrapper forwards the separate receipt field to Gateway and strips it before
remote dispatch. A callback is not assumed to fire in other permission modes;
the broker remains the final enforcement boundary.

Gateway revokes its bearer at cancellation onset and requests Platform lease
revoke. Revoke marks pending and approved challenges invalid in the same
transaction. A per-challenge native cancel also revokes an approved but
unconsumed receipt under the lease lock. If cancellation wins the database
race, consume cannot dispatch. If consume commits first, the remote call may
already have begun; abort it best effort, but do not claim a remote side
effect was rolled back. On an uncertain decision RPC, deny the native call and
resolve the local prompt without reissuing approval. Failed Platform revoke
cannot be reported as a confirmed server-side revocation.

If lease registration fails before Claude launch, ordinary Chat remains usable:
the exact Custom MCP tool reaches the broker without a receipt. Current
`allow` policy may pass; `always_ask` remains denied. The fallback strips any
model-supplied receipt before forwarding.

## Focused extraction plan

Approval-specific state and proof logic live in `approval-store.ts`,
`approval-routes.ts`, `approval-digest.ts`, `claude-custom-mcp-approval.ts`,
and Platform's `custom-mcp-approval-proof.ts` and
`custom-mcp-approval-route-options.ts`. `platform-db.ts` retains schema
migration and thin store delegation; a future database migration refactor
should move the Custom MCP DDL into a migration module without changing its
transaction or index semantics. The existing
`session-routing-middleware.ts` and `chat/orchestrator.ts` exceed 1,000 lines;
future scoped cleanup can extract approval proxying and canonical approval
submission respectively while preserving the current auth and active-Run
checks. This PR adds only narrow calls to those composition files.

## RED → GREEN acceptance matrix

The initial RED tests assert the current boundaries: Boolean approval alone
must fail at the broker, the run registry must expose authenticated provenance,
the supervised Claude call tool must cease autoapproval, and durable lease /
approval tables must exist. Implementation then adds transaction-backed tests:

1. `allow` fast path succeeds without approval UI; `always_ask` emits one
   pending challenge, authenticated approve yields exactly one remote call;
   explicit deny yields zero calls.
2. Expired/replayed/altered-argument/wrong-actor/wrong-run/wrong-server/wrong-
   revision/wrong-tool receipts yield zero remote calls. Concurrent consumption
   permits one dispatch. Stale or unknown current policy denies reserve and
   consume, including allow→always_ask and revision-change races.
3. A scoped bearer cannot call the internal decision route or use raw
   `approvalGranted:true`; a machine-auth call cannot turn an arbitrary Boolean
   into a receipt. Cross-owner Chat approval, stale approval ID, and forged
   native callback ID fail closed.
4. Native `can_use_tool` carries the exact parsed input; `updatedInput` carries
   only the issued receipt. Deny, native cancel, Run cancel, disconnect,
   shutdown, and pending/lease capacity or expiry do not dispatch. The
   consume-wins cancel race is reported as an uncertain in-flight call.
5. Existing SSRF, DNS pinning, redirect denial, 64 KB call body limit, generic
   error behavior, server policy/owner isolation, and review discovery-only
   tests remain green. The Codex and Hermes `always_ask` capability table
   stays `unsupported` until separately proven by real local harness fixtures.

After GREEN implementation, update the public-safe integration architecture
documentation (currently `docs/architecture/agent-integrations.md` says
`always_ask` is unsupported) and the public-site Custom MCP discovery versus
execution/approval/supported-harness guidance requested by the recovery plan.
This docs update depends on the exact implemented capability matrix, not this
RED-only contract.

No live account, provider credential, paid model request, production deploy,
merge, or external communication is part of this contract.
