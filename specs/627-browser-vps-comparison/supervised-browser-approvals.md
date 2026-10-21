# Supervised shared Chrome: owner approval and recovery

## Status and evidence

This is the test-first BROWSER-R7 contract. Delivery order is shared Chrome →
R5 Codex transport → [R8 Chat naming #2660](https://github.com/HamedMP/matrix-os/pull/2660)
→ [R6 failed-bootstrap retry #2659](https://github.com/HamedMP/matrix-os/pull/2659)
→ A authority/contracts → B broker/native → C shared Figma UI. Layer A starts
on exact R6 source `1b4d47c729b208f84e47ae24c581c90f8032137c`.
Production changes are not unlocked by this document. Native startup and
failed-bootstrap retry belong to separate owners.

The current native admission helper returns no browser capability in Supervised
mode. Simply registering the MCP server would not repair this safely: Claude's
unhandled permission callbacks deny it, and the existing browser broker accepts
every schema-valid action from a live bearer without a per-action approval gate.
The new regression exercises the actual broker and canonical owner route;
rendering a synthetic permission card alone cannot satisfy it.

Design reference: [ENG-267 permission flow](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1918-7354).
Historical [ENG-267](https://linear.app/matrix-os/issue/ENG-267/fixchat-offer-tool-approval-instead-of-a-dead-end-denial-in-supervised)
concerns native Claude integration permissions. The explicit user request here
extends the same experience to Codex and Claude shared Chrome under
[MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix).
This document does not silently change those tickets or another owner's PR.

## User contract and surface parity

Web Canvas, Web Desktop and Electron Desktop consume one shared approval view
and action contract. Web Mobile and Native Mobile retain the same meaning and
actions wherever browser Chat tools are available; platform layout may adapt.

1. Supervised native Codex and Claude can discover the fixed Matrix Browser
   tool. Discovery alone never touches a page or disables human input.
2. A real browser attempt produces the inline **what / why** permission card
   in the originating Chat, a compact sticky bar above its composer, and the
   canonical **Needs you** state. There is one challenge, not three decisions.
3. **Allow once** authorizes exactly the pending parsed action. **Allow in this
   Chat** explicitly creates the distinct browser Chat grant described below,
   then permits this pending action. It is never a native
   `approve_for_session` response and never an account-wide grant.
4. Allowed state contracts to a small recorded outcome and work continues in
   the same Run. A remembered grant says **in this Chat** and offers **Undo**.
5. **Not now** records a decline, performs no browser effect, and allows a
   normal agent explanation or alternative. It is not a generic failed-Run
   dead end. Keep a deliberate retry path without replaying the declined call.
6. Expiry records **Expired**, removes approval controls and presents **Try
   again**. This requests a fresh challenge for still-needed work after current
   run/owner/observation checks; it never approves or resurrects the old one.
   Terminal Runs require a new explicit retry attempt through canonical Chat.
7. **Always allow / Full access** opens the existing mode menu. The user must
   choose the mode; it applies only to the next request. The waiting request
   remains pending until its own decision, expiry or cancellation.
8. Undo revokes the remembered grant immediately at its execution boundary.
   It does not claim to roll back a browser effect already dispatched.
9. Full access remains explicit automatic browser authority. No permission
   prompt is used to mask an unrelated native startup, login or transport fault.

## Execution and authority boundary

Add a server-created lease policy to `broker.openRun(binding, signal, policy)`.
The provisional test contract is `{ mode: "supervised", authorizeAction }`;
full-access callers keep their existing behavior. Policy and callbacks are
internal dependencies, absent from the model-facing action schema and token.
The policy is immutable for the lease and cannot be upgraded by prompt text.

The broker gates every page-observing or page-changing action, including tabs
and snapshots, before claiming Chrome, disabling human input or calling the
driver. Coarse `status` may remain non-sensitive and prompt-free. A request
without the required authorizer fails closed. Direct authenticated bearer
calls and all native MCP paths use this same gate; SDK permission callbacks
must not be the sole protection.

The authorizer retains the exact validated action in bounded process memory,
derives a domain-separated canonical SHA-256 action digest, and captures owner,
Chat, Run, random lease epoch, browser control revision, creation and expiry.
The exact action object used for digest is the object ultimately dispatched.
Challenge identity also binds a random per-attempt nonce. Native callback IDs,
tool names, webpage text or model-supplied explanations are never authority.

Before releasing a challenge, verify authenticated decision provenance, exact
tuple, allowed decision, live pending state, deadline and lease. One
conditional claim wins; duplicate/concurrent decisions cannot dispatch twice.
Allow once is consumed before dispatch, including failure or ambiguous outcome.
No receipt or capability is returned to the model as a durable authority flag.

Approval waiting occurs outside the physical driver/action cleanup lock. Human
input remains enabled until actual agent claim. Recheck lease identity,
cancellation, control revision and observation at release and immediately
before dispatch. Pause/takeover/stop invalidates the pending effect; stale
click/type/select/download refs require a new observation and new approval.
Resume is not approval, and approval is not Resume. A cancelled or uncertain
browser effect is never automatically replayed.

Native Claude may explicitly permit its exact fixed browser tool to reach the
broker after proving the supervisor is installed; other tools keep their
existing policy. Native Codex's exact current transport must be fixture-tested
for confirmation behavior. Any native callback accepted only to reach this gate
does not authorize Chrome itself. Model-controlled MCP config, startup argv,
bearer fields or native confirmations cannot bypass the broker.

## Auth matrix and contracts

| Boundary | Authority and validation | Result |
| --- | --- | --- |
| Native browser discovery | Personal owner, exact active canonical Run, default interaction, supported native harness | Fixed tool only; no action |
| `POST /apps/browser-lab/api/agent-action` | Existing fixed loopback/run bearer, strict action schema, body limit, lease policy | Supervised action waits at broker; no caller approval Boolean |
| `POST /api/chats/:chatId/runs/:runId/approvals/:approvalId` | Existing authenticated owner route, canonical active Run and pending challenge, exact action digest and decision | One pending browser decision; foreign/stale identity denied |
| Browser Chat grant create | Explicit `allow_in_chat` decision on a live browser challenge; authenticated owner/Chat, action digest, revision and idempotency key | Atomic grant + challenge decision metadata only |
| `DELETE /api/chats/:chatId/browser-grants/:grantId` | Authenticated personal Chat owner, strict IDs, body limit, bounded body schema and expected grant revision | Conditional revoke + execution fence; unknown foreign grant is generic miss |
| Read Chat grant state | Existing owner-authorized Chat detail projection, capped summaries | Safe scope and revision; no bearer or action input |
| Model/tool/API caller, org/shared scope, review mode | No authenticated owner decision or unsupported browser authority | Cannot issue or revive permission |

Use a separate typed browser decision discriminator: `allow_once`,
`allow_in_chat`, `not_now`, `cancel`. Map only the appropriate canonical
decisions at the browser controller boundary; do not reinterpret another
integration's `approve_for_session`. Add a versioned browser-approval payload
to canonical events/submission that carries kind, expiry, typed decision and
resolution reason. Existing producers/readers retain their current semantics.
An expired browser approval is not inferred from generic cancellation.

Use authenticated canonical owner provenance from the platform, including a
signed exact action digest. Define browser grant decision proof separately
from the existing Custom MCP proof domain and verification tuple. Existing
integration proof semantics and `approve_for_session` rejection remain
unchanged. A VPS machine bearer, app token or native callback cannot mint a
human browser decision. Include explicit preview desktop owner authentication
in this new proof path; never broaden all existing integration proof paths.
Bind nonce, owner, Chat, Run, approval, action digest, typed decision, expected
grant revision, idempotency key and expiry; consume once transactionally.

No new publicly reachable broker/admin endpoint is required. The grant DELETE
uses route-boundary Zod validation, `bodyLimit`, generic errors, explicit origin
policy and current owner membership checks. Existing query-token WebSocket
authorization remains unchanged unless a new WS route is actually added.

## Owner-controlled persistence and concurrency

Persist browser grant and decision **metadata only** in owner Postgres/Kysely.
The minimum grant tuple is random ID, owner, Chat, capability
`shared_chrome`, explicit scope version, revision, active/revoked state,
created/revoked timestamps and the originating approved challenge identity.
Scope is the shared Chrome capability **in this Chat only**, clearly explained
before selection. This is the same persistent Chrome profile, including its
signed-in accounts: the UI must say so. It does not authorize shell commands,
another Chat, another computer or an unrelated integration. Existing browser
handoff protections and tool limits still apply, but prompt instructions alone
do not prove credential pages or password-manager contents are inaccessible.
Do not advertise such exclusions unless a separately tested runtime boundary
actually enforces them. The grant never changes the saved Chat permission mode.

Challenges persist only safe identity/digest/expiry/state/outcome metadata
needed for history and duplicate decisions. Never persist bearer tokens, raw
actions, entered values, page contents, cookies, password-manager information
or untrusted webpage explanations in approval/grant records. Process restart
cannot reconstruct or execute an action from metadata: mark old pending
challenges interrupted/expired and require a fresh actual tool attempt.

Create grant + consume challenge in one transaction, locking the owner/Chat
grant scope and enforcing the pending/revision/lease checks in write predicates.
Use `ON CONFLICT` for idempotent admission. Grant revocation increments its
revision under CAS and fences dispatch under the same authority ordering.
Document the consume-wins race: a driver operation already started may have an
effect; abort/drain best effort and report the checked outcome without rollback
claims. Two operations must not both claim the same decision nonce.

Grant validation occurs at each broker action, not once at Chat/native process
creation. A remembered grant never applies through Chat conversion, foreign
owner scope, archived/deleted Chat, unsupported interaction mode or stale lease.
Use current-grant checks with a bounded owned DB deadline; no unbounded cache of
permission truth. Publish safe revision changes after commit so all clients
drop stale pending/remembered controls.

## Limits, expiry and cleanup

- At most 16 live pending challenges per Run, 64 native leases per broker and
  128 live challenges per owner; capacity denies without dispatch. Keep existing
  action/body/response limits and 30-second physical action deadlines.
- Challenge expiry is at most five minutes and never beyond its lease.
  The total MCP wait remains bounded by the existing six-minute transport
  deadline. Do not stack independent waits into an unbounded operation.
- Race decision/expiry/cancel under one conditional transition. Resolve pending
  promises once, clear timers/listeners and evict terminal process entries.
- Abort, native cancel, Run end, stop, disconnect requiring teardown, shutdown
  and failed approval delivery deny all unresolved requests. Drain owned work
  before releasing a native admission. Late success cannot approve a successor.
- Cap live remembered grants per owner and one active logical grant per Chat
  scope; define bounded indexed recurring retention for terminal challenges
  and revoked metadata. Retain tombstones at least through the maximum signed
  proof lifetime so pruning cannot revive a nonce or old lease.
- Borrow the existing owner DB resource and shutdown hooks. Only its owner may
  destroy its pool. New code owns only its own timers, listeners and maps.

## Presentation safety and Figma states

Derive **what** from the validated action kind and bounded safe target evidence.
Derive **why** from the user's requested task and an explicit agent explanation
treated as untrusted text, never markup or authorization. Cap both before
display/persistence. Withhold typed/select values and URL credentials/query/
fragment; do not claim a withheld payload was reviewed in full. If the exact
action cannot be represented safely enough for a meaningful decision, deny and
ask for a smaller/manual step instead of misleading approval copy.

Build one shared pure state derivation and one reusable approval presentation
for inline card, sticky bar, Needs you and remembered-grant Undo. Reuse existing
brand/UI primitives and canonical Chat navigation. Renderers must not separately
infer approval or expiry from model prose. A local countdown is presentation;
server pending state and deadline remain authoritative. Preserve current Chat
and route guards during decision, grant revoke and refresh failures. Never clear
optimistic pending state before a confirmed server response.

## Extraction and validation plan

Keep new focused modules below 500 lines. Extract shared-browser approval
controller, action digest/display, grant repository and adapter event merging
from composition entrypoints. Do not add behavior directly to the 1,000+ line
Claude adapter/orchestrator without first extracting the touched responsibility;
keep composition changes to injected ports. The 300-line broker delegates
permission logic rather than becoming another cross-domain store.

RED bootstrap files:

- `tests/gateway/shared-browser-supervised-admission.test.ts`: both native
  harnesses discover a fixed tool, with zero driver calls at admission.
- `tests/gateway/shared-browser-supervised-approval-boundary.test.ts`: real
  broker execute from its capability binding, real canonical repository,
  orchestrator and owner POST; zero dispatch before decision and exactly one
  after it. The policy port is test-local until implementation. This fixture
  does not claim real provider transport or platform cryptographic acceptance.

Before GREEN, extend tests for deny/expiry/cancel/shutdown/capacity; wrong owner,
Chat, Run, digest, nonce, epoch and revision; two competing decisions; takeover
while waiting; grant idempotency/revocation races and restart; direct bearer
bypass; Full access preservation; native Codex and Claude transport fixtures;
canonical expiry compatibility; and every shared Figma state/action. Use real
disposable PostgreSQL for new persistence and race acceptance, not a new
embedded production store. Validate forged proof and stale direct API calls.

Root runs tests only on the scoped disposable VPS or GitHub. No local test,
build, install, dev server, Electron process or paid model probe is authorized
by this bootstrap. Root captures Web Canvas, Web Desktop and Electron Desktop
when permitted, including approved/declined/expired/reloaded states, in-flight
takeover, remembered grant Undo, and next-request-only Full access. Component
fixtures are not actual native/browser acceptance. Follow required React Doctor
and accessibility/layout checks on an authorized remote test environment.

Public docs deliverable: a separate `FinnaAI/matrix-os-site` PR must explain
Supervised browser permission, exact one-call versus Chat scope, Undo, expiry,
takeover and model/CLI setup. Preserve existing guide work. Finish current-head
CI and Greptile 5/5, add `ready-for-ci` then retain this PR unmerged for review.

## Delivery decomposition and live platform acceptance

The full Figma scope is split into three dependent GitHub PRs owned by the same
BROWSER-R7 owner. Layer A starts on R6 after R8; B starts on A and C starts on B.
Existing admission/broker RED files remain
preserved until assigned to B. See [the concrete layer plan](supervised-browser-layers.md).

Host-only installation cannot establish the new human-approval proof. The
current `app.matrix-os.com/vm/...` proxy verifies the owner session, then replaces
Authorization with a machine credential and generic actor headers. Those
headers, a host-known HMAC, native callback, or a configured-owner principal
cannot replace the new signed browser decision. The current platform signer
recognizes only the existing integration approval body and domain.

Layer A therefore includes an independently domain-separated browser signer
and verifier on the platform and exact-source platform-to-gateway fixtures.
Any live acceptance needs that reviewed platform candidate as well as the host
bundle. The existing one-Chat candidate selector is source-PR/handle/tag bound;
keep that invariant. Do not relax the selector, reuse an old operator payload,
change platform default traffic, mutate operator configuration or provision a
new VM as part of this bootstrap. Root must choose an already authorized,
matching candidate/runtime path before live acceptance; until then report that
gate pending. Synthetic fixtures do not establish live human approval.

Request review from the design/ENG-267 stakeholder and browser-stack owner when
the concrete draft is available. This is a review recommendation, not an
additional user-confirmation gate: the user already directed the experience.
