# Claude Code Chat built-in integrations

Tracking: ENG-43.

Claude's explicit ask-rule contract is documented in its
[official permission reference](https://code.claude.com/docs/en/permissions).
Gateway enforcement remains authoritative if a CLI skips a callback.

## Contract

Claude Code canonical Chat exposes Settings-connected integration inventory,
schemas, explicit-account actions and account management alongside Custom MCP.
The executing harness owns tool support; a model/provider login does not add tools.
Existing full Terminal, kernel and restricted Jev surfaces remain independent.

The existing explicitly opted-in `integration_read` and legacy Custom MCP
read surfaces retain their verified owner startup and read-only broker routes.
They are separate from native Chat's `chat_call` / `chat_discovery` authority:
Chat never receives `/api/integrations/read-call` or automatic `call_service`
approval from the legacy read flag. Scope issuance rejects that mixed opt-in,
and one stdio surface registers each integration tool only once.

## Authorization matrix

| Route | Claude Chat discovery | Claude Chat action scope |
| --- | --- | --- |
| GET /api/integrations | Owner/run metadata | Owner/run metadata |
| GET /api/integrations/agent-catalog | Owner/run schemas | Owner/run schemas |
| POST /api/integrations/call | Denied | Exact account/action/params authorized once |
| POST /api/integrations/connect or /sync | Denied | Exact request authorized once |
| DELETE /api/integrations/:uuid | Denied | Exact connection authorized once |
| Custom MCP inventory/detail/call | Existing discovery policy | Existing broker policy/receipts |
| Other routes, writes, approval submissions | Denied | Denied |

Supervised, accept-edits and automatic modes require the canonical human approval
for each built-in action. Full access is explicit run-level authority for these
specific integration routes. Review mode has discovery only. Tool configuration
and model-provided approval fields never grant authority.

The Gateway registry binds the personal owner, live run, expiry and bounded
one-use action grants. Canonical approvals verify the Platform-signed actor/chat/
run/approval/decision proof before creating a grant. Grants bind normalized JSON
request arguments and a unique unpredictable execution receipt, expire promptly and
are cleared on steering/run cancellation/completion. Verified native approvals add
the receipt to `updatedInput`; the MCP boundary carries it only in a local Gateway
header, stripped before Platform forwarding. Supervised requests without the exact
receipt never fall back to argument-only matching. Model-supplied receipts in native
approval requests are rejected.
Cancelling one native permission request retracts only its own outstanding grant,
including when another approval has identical arguments. Other integration and
Custom MCP authority remains live; native transport failure closes run authority.
Managed OAuth and MCP preset calls resolve every explicit label or connection ID
against the authenticated owner's active accounts before broker execution. Missing,
ambiguous or mismatched selections are denied; the broker receives the resolved
immutable ID. Only legacy calls with neither selector retain broker defaults.
The approved request body and exact receipt remain unchanged by internal selection.

Approval titles use the shared persisted safe-label contract with a fixed safe
fallback. A valid account label that resembles private credential text still
requests approval; projection never changes its exact action or account arguments.
Integration account credentials stay at the provider boundary. Host control
bearers and their upgrade/code-proxy aliases are removed from the agent's
environment; its selected Claude model credential remains available to the CLI.

Platform proof verification reuses the existing authenticated customer integration
boundary, body limits and default preview denial. The new route handler is extracted into
a focused module rather than adding behavior to the large startup composition.
Gateway approval projection is likewise extracted from the large Claude adapter.

## Shared Preview Google Drive acceptance extension

Shared Preview machine credentials are accessible from Terminal and never grant
personal integration authority. Only an authenticated browser turn can establish
an actor/handle/run scoped Preview Drive lease. The canonical Chat approval
must bind the exact `google_drive.list_files` request digest; Platform issues
and atomically consumes a short-lived one-use grant for an explicit account
label and `maxResults` from 1 to 3. Preview discovery exposes only the Google
Drive connection and schema. Connect, sync, disconnect, file content, other
services, full-access bypass and Custom MCP remain denied. Provider credentials
stay with Platform. Returned metadata may be visible to other shared Terminal
users; this is an explicit acceptance risk, not a confidentiality guarantee.

For shared Preview acceptance without a personal Claude subscription, Chat
projects a separate Claude Code instance only when the CLI is installed and the
Matrix-funded source and exact model are ready. Selecting that instance always
requests a short-lived `matrix_included` credential for the run, even when an
owner Claude credential exists; it never falls back to that owner credential.
Native funded execution uses a dedicated credential factory, not
`buildKernelCredentialLaunch(matrix_included)`; the SDK-funded route stays denied.
The factory validates the exact Run claim before leasing interactive credit,
uses an allowlist of runtime environment variables plus the relay token/base URL
and claim header, and caps the run deadline by the provider and lease limits.
A separate persistent `system/provider-profiles/claude-matrix` directory holds
funded native sessions for resume. It never borrows the subscription profile;
model discovery does not acquire a funded lease. Native launch continues to
ignore owner/project settings and use the explicit Matrix MCP configuration.
The standard Claude Code instance retains its independent authentication state.
Funding limits and model policy remain enforced by Platform and the relay.

Preview proof redemption may yield while other admissions or shutdown proceed.
Keep the initial dispatch guard to avoid unnecessary redemption, then recheck
current owner/global capacity, stopping execution and shutdown synchronously
before dispatch registers its active Run. No await separates a successful final
guard from registration. Rejected admitted Runs become terminal failed with the
canonical generic busy/stopping/shutdown response, and pending admission ownership
is released even if failure persistence throws. Existing limits, provider
credentials and Preview grant permissions are unchanged. A redeemed pending lease
returns an idempotent disposer bound to its exact actor, Chat, Run and grant.
Rejection or synchronous failure to start disposes the pending entry before
invoking best-effort Platform revocation, including when failure persistence
throws. Cleanup errors are logged and pending admission ownership is always
released. A successful dispatch transfers revocation ownership to the issued
capability; stale disposers cannot remove replacement leases. The existing
bounded revocation client and lease expiry remain the fallback on network failure.

## Published provider compatibility

The latest Codex provider gate qualifies published 0.162.1 against its tagged
exec source and package-generated experimental app-server schema. Both inputs
are byte-identical to the reviewed 0.162.0 fixtures; all eleven consumed request
and notification digests are unchanged. Reusing those fixtures preserves their
0.162.0 provenance and the earlier payload-change assertions.

Both exec and app-server manifests advance together. Historical versions remain
verified; unknown newer versions still fail closed. The installer pin, parsers,
fixtures, strict checker and workflow stay unchanged. Real Linux and macOS
published-package CI checks must pass for the current commit before merge.

## Validation and delivery

1. Red/green public MCP transport tests for inventory/schema/action discovery.
2. Authenticated Gateway contract tests for exact grants, replay, wrong arguments,
   owner isolation, expiry, review, full access and revocation.
3. Native Claude control-protocol tests for pending, approve, decline, cancel,
   proof failures and fresh/resumed runs; preserve Custom MCP receipts.
4. Platform route tests reject invalid proofs, unauthenticated identities and
   ordinary Preview personal-account access. Preview one-use grants are stored
   as expiring hashes in Platform Postgres; no provider credential is exposed.
5. Publish an exact-head PR Preview VPS; check immutable release/health, synthetic
   acceptance and machine-only denial. The narrow browser-bound Drive path is
   the only Preview exception to personal integration denial.
6. With the account owner's explicit acceptance of shared-Terminal result
   visibility, verify inventory, schema and one approved bounded Drive metadata
   read in fresh Claude Chat. Record the serving Platform revision, host bundle
   and actual Chat outcome; repeat in a new run only with a fresh browser grant.

The separate Platform Preview service uses staging data and cannot validate a
production Drive connection. For the shared Preview acceptance, keep a tagged
revision of the production Platform service at zero default traffic and route
only one exact Preview Chat's browser turn and approval POSTs to that revision.
The operator-label workflow admits only a bounded current same-repository PR.
A freshly reviewed `preview-chat-candidate-pr-<N>` secret must bind `prNumber`,
`approvedHeadSha`, `approvedHeadRef`, `handle`, `chatId`, `candidateOrigin` and
`expiresAt` to that frozen PR. Old PR payloads fail closed. Exact-head tests and
the Production environment gate precede secret work. Fresh PR number/open-state,
repository/branch/SHA/label checks run before selector secret access and again
immediately before Edge mutation, with another expiry check after the read-only
Cloudflare probe. Configuring that private payload is a separate operator
precondition; owner Main acceptance does not require deploying this selector.

The temporary Edge Router selector requires the exact Preview handle, Chat ID,
same-service candidate origin, and an expiry within two hours. It preserves
the trusted external host and Edge secret; Platform still verifies the browser
session before minting an actor proof. All other routes continue to the default
production Platform revision. The operator must verify the selected response
marker, wrong-Chat default routing, and removal or expiry of the selector.

The gateway contract is shared by Electron Desktop, Web Desktop and Web Canvas.
No shell business logic is duplicated. Record live surface coverage separately.
Public support guidance and the harness support matrix live in this repository;
the private site documentation track is outside this support-fix scope.

## Main integration compatibility and owner-runtime acceptance

The Claude discovery surface composes personal integration inventory with company
Drive context tools. Company context keeps its independent membership and resource
authorization; discovering either surface does not grant personal action authority.
Shared Preview discovery and calls remain restricted to their browser-bound Drive
lease and must reject company context tools. The installed host launcher recognizes
the explicit `preview-drive-call` surface so an approved request reaches the same
scoped Gateway boundary as the development launcher.

Action grants bind the selected immutable connection ID and provider account ID
at issuance. Execution revalidates both IDs, active owner scope and the unchanged
approved label at provider dispatch; same-label reconnections and legacy unbound
grants are denied. The actor deletion transaction also holds the run row lock
through discovery, grant issuance and consumption/provider execution. Revocation
uses that same lock and marks rows consumed, retaining proof nonce uniqueness
until the existing expiry. Operations admitted before revocation may finish;
operations serialized behind revocation are denied.

Signed turn and approval proof expiry is rechecked after admission/row-lock waits
before issuing new authority; an admitted provider call may finish.
Generation 17 adds nullable binding columns while preserving the deployed
generation 16 fingerprint, nonce rows and unrelated owner data.
Tests cover proof replay/expiry/body binding, transactional grant consumption,
actor deletion and shared Web/Electron/Mobile optional-digest parity. Preview
access requires the scoped runtime capability layer and explicit policy.

Provider-login discovery retries must use the latest Terminal session snapshot.
A newer missing or ended snapshot cannot be overridden by a delayed result from an
older poll. Tool activity detail must retain the Canonical event schema shape and
sanitized command preview; private reply path projection must not change that
separate activity contract.

An explicitly authorized owner-runtime acceptance may install the immutable PR
bundle on the owner's Main computer through scoped registered-bundle deployment.
Record its prior version as the rollback target, preserve owner files, database,
sessions, update subscription and provider credentials, and verify the installed
release and Gateway/Shell/Sync health. Use the owner's existing Claude subscription
and ordinary personal integration authorization. Do not transfer shared Preview
model credentials, actor selectors or funding policy to the owner runtime.

Acceptance requires a fresh Claude Chat with native approval, an explicit connected
account and `google_drive.list_files` capped at three metadata records, followed by
visible model continuation. Credential-file presence alone is not provider
readiness. Record actual authentication and live surface coverage before claiming
success; file content and write operations are outside this acceptance scope.

## Revised review and rollout order

The owner approved source and regression verification of Claude built-in integrations
and Custom MCP, followed by fresh Greptile 5/5 and green CI on the final PR head,
then merge. Real Google Drive acceptance is performed after merge by the affected
user on a matching runtime and Platform revision. Owner subscription login and an
owner-runtime live test are no longer pre-merge gates. This changes rollout order,
not the authorization contract or the evidence required to claim live success.

## 2026-10-09 owner acceptance and current-main compatibility

The owner renewed the Claude subscription and explicitly resumed pre-merge Main
computer acceptance after merging current main. This supersedes the previous
rollout order: verify the immutable PR bundle on the owner's runtime first, then
require fresh Greptile 5/5 and green CI on the final head before merge. Keep the
existing affected-user post-merge verification separate from owner acceptance.

Current main uses managed Pi for Matrix AI Chat. Preserve that managed broker
and the retired Claude SDK Chat behavior; the separate installed Claude Code
adapter retains its native subscription and Matrix-funded source boundaries.
Native launch capabilities must keep `chat_call` or `chat_discovery` rather than
downgrading either to a Custom-MCP-only scope. Funded credentials resolve by both
instance ID and run ID; they cannot replace native subscription credentials.

### Preview actor deletion admission contract

1. **Scope:** shared Preview personal Drive authorization must honor the actual
   actor's account deletion state, independently of the shared machine owner.
2. **Signatures:** `/internal/containers/:handle/preview-drive/{turn/redeem,
   discover,grant,execute}` resolves the signed actor/run before calling
   `withAccountDeletionOwnerLock(db, actorId, callback, env)`.
3. **Contract:** keep the owner lock through grant writes and provider execution.
   The grant store participates in the ambient transaction. A failed provider
   operation still commits consumption of the one-use action grant.
4. **Errors:** scheduled, processing and completed deletion deny new work with
   409; admission infrastructure failure returns generic 503. Revoke cleanup
   remains permitted. Provider failure cannot restore a consumed action grant.
5. **Cases:** active actor may redeem/discover/grant/execute; actor with deletion
   pending cannot use an otherwise valid run; cleanup may revoke an existing run.
6. **Tests:** database-backed PGlite tests assert denial in all deletion states at
   each phase, allowed cleanup, and no replay following provider failure under
   the owner transaction.
7. **Wrong vs correct:** checking only the shared machine owner's state or
   rolling back a provider-error response can bypass deletion or replay a grant.
   Lock the signed actor and commit one-use consumption before returning failure.

### Startup revision and activity compatibility

The current additive union allocates core schema generation 19 above main 18
and deployed Preview 17 (the immutable-binding successor to original 16).
A same-generation fingerprint mismatch still fails closed; never reset a deployed
marker to make startup pass. Actual disposable PostgreSQL 16 tests upgrade foreign
17 and main 18, preserve grant/owner rows, balances and additive columns, and
verify older instances skip. Main 18's waiver indexes and the full union schema
baseline match after upgrade. PGlite covers older predecessors independently.
These tests establish compatibility; Cloud Run startup and installed runtime
provenance must establish deployment success separately.

Private owner file-path previews retain main's absolute-path presentation, even
outside the execution root. Commands, working directories, queries and patterns
always use safe projection. Shared file paths remain relative or omitted; secret
paths remain hidden in every scope. Steer HTTP events and Electron transcript
tests verify the path contract before completion. The route admission contract
includes the optional fifth browser approval-provenance argument.

### Preview endpoint authorization matrix

Every route below is mounted at `/internal/containers/:handle/preview-drive`
and requires the handle-derived machine bearer plus a current running Preview
machine record. The bearer supplies transport authentication, not actor authority.
All request bodies use the shared 4000-byte limit and strict per-action schemas.

| Method and route | Personal account authority | Admission and execution boundary |
| --- | --- | --- |
| POST /turn/redeem | Fresh Platform-signed browser actor, Chat and body proof | Current Preview access; actor deletion lock; atomic one-use nonce redemption |
| POST /discover | Opaque actor/handle/Chat/run grant | Current actor access and deletion lock; Drive inventory/schema only |
| POST /grants | Run grant and signed browser approval bound to exact action digest | Current actor access and deletion lock; explicit connected label; one-use approval nonce |
| POST /execute | Run grant and one-use exact action grant | Current actor access and deletion lock; atomic consumption before bounded metadata read; failure still consumes grant |
| POST /revoke | Exact run grant, handle, Chat and run | Cleanup only; allowed while actor deletion is pending; revokes run and unused action grants |

Machine-only requests, unsigned actor headers, session-wide approvals, other
services, account management and Custom MCP cannot authorize a Drive read.
Run grants expire after 35 minutes; action grants after 90 seconds. A recurring
Platform sweep removes expired rows. Returned metadata remains visible to shared
Terminal users under the account owner's explicitly accepted test boundary.

### Signed user-session origin on shared Preview

A personal Preview turn or action approval requires an authenticated identity with
positive verified `clerk-device` or `clerk-browser` session provenance. The Platform
signs the optional sync-JWT claim only after the Clerk-approved device flow or a
fresh verified Clerk browser exchange. Bearer, app-cookie and code-cookie transport
preserve the same verified authority; native presentation markers confer none.
Direct verified Clerk routing establishes browser provenance. Generic, delegated
and legacy sync tokens retain existing routing/authentication but cannot mint
Preview Drive turn or action proofs, including after native cookie exchange.
Native app-session exchanges retain the verified JWT bytes, claim class and expiry;
the native presentation marker cannot upgrade generic tokens into personal authority.

Runtime selection and JWT-derived code-cookie renewal preserve the original
verified expiry; expired sessions acquire no personal authority through clock
tolerance or renewal; both proof paths recheck source expiry after bounded body reads. Fresh Clerk authentication may use the existing browser
session lifetime. Previously issued unmarked device/browser sessions may require
fresh Matrix sign-in for shared Preview authorization; Claude subscription
credentials are unchanged. Ordinary owner-machine Custom MCP approvals retain
existing semantics. Shared Preview classification comes from the current database
machine, not a handle shape or native-client marker. Existing signed actor/access,
exact turn/action digest, supervised/default mode, expiry and one-use grant checks
and the three-record Drive metadata bound remain required.

The existing large session-routing middleware receives only proof policy inputs
and renewal wiring. Session validation and lifetime derivation stay in the focused
JWT/identity/proof helpers; future routing composition changes should extract a
standalone session-cookie renewal module before adding policy to that middleware.
