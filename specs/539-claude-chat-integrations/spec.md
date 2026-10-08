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
The standard Claude Code instance retains its independent authentication state.
Funding limits and model policy remain enforced by Platform and the relay.

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

An integration merge allocates core schema generation 16 above the observed
production generation 14 and shared Preview generation 15. A same-generation
fingerprint mismatch still fails closed; never reset a deployed marker to make
startup pass. Startup upgrade tests retain owner rows and unrelated additive
columns, create the Preview Drive grant tables, and verify older instances skip
the completed generation. PGlite regressions establish the contract; Cloud Run
startup and live PostgreSQL checks establish deployment success separately.

Private owner file-path previews retain main's absolute-path presentation, even
outside the execution root. Commands, working directories, queries and patterns
always use safe projection. Shared file paths remain relative or omitted; secret
paths remain hidden in every scope. Steer HTTP events and Electron transcript
tests verify the path contract before completion. The route admission contract
includes the optional fifth browser approval-provenance argument.
