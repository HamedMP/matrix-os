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

Owner tests cover native approve/decline/cancel, exact one-use receipts, replay,
fresh and resumed Chat, independent Custom MCP policy, installed MCP launcher,
company Drive composition and provider Settings Terminal handoff.

Private owner file paths retain absolute presentation when safe. Commands and
working directories keep safe projection; secret paths remain hidden. Review
runs remain discovery-only. Preview runtimes retain ordinary personal-account
denial. Native account resolution preserves run and selected instance binding.

Delivery requires matching immutable Gateway and Platform versions, green CI,
fresh Greptile 5/5, and owner runtime testing using the owner's existing Claude
subscription. A tool checkpoint alone is not a visible Chat continuation pass.
No provider credentials, OAuth tokens, owner data, or update channel are copied
between machines. Public-site documentation is outside this support-fix scope.

## Preview Platform and optional approval protocol

Authenticated Preview turn requests mint short-lived body-bound actor proofs.
Platform grant redemption, inventory, exact-action issuance and execution use
stored actor/handle/run identity. Only google_drive.list_files with an explicit
label and maxResults from 1 to 3 is permitted. Account-deletion admission locks
the signed actor; provider failure consumes the one-use action grant. Nonces and
grants have TTL cleanup. Machine bearer or unsigned actor headers alone never
select a personal connection. Owner approvals may omit the new digest.

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
actor deletion and shared Web/Electron/Mobile optional-digest parity. The runtime
consumer is deliberately absent in this layer; Preview remains denied until it
is deployed with the separate run-capability layer and explicit scoped policy.

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
