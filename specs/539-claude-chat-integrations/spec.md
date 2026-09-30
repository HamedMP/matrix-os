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

The tagged Platform Preview uses staging data and cannot validate a production
Drive connection. A real owner-account test requires a separately reviewed
production Platform rollout of the narrow route before the Preview Chat run.

The gateway contract is shared by Electron Desktop, Web Desktop and Web Canvas.
No shell business logic is duplicated. Record live surface coverage separately.
Public support guidance and the harness support matrix live in this repository;
the private site documentation track is outside this support-fix scope.
