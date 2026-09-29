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
request arguments, expire promptly and are cleared on steering/cancel/completion.
Provider credentials and machine bearers stay outside the launched agent.

Platform proof verification reuses the existing authenticated customer integration
boundary, body limits and preview denial. The new route handler is extracted into
a focused module rather than adding behavior to the large startup composition.
Gateway approval projection is likewise extracted from the large Claude adapter.

## Validation and delivery

1. Red/green public MCP transport tests for inventory/schema/action discovery.
2. Authenticated Gateway contract tests for exact grants, replay, wrong arguments,
   owner isolation, expiry, review, full access and revocation.
3. Native Claude control-protocol tests for pending, approve, decline, cancel,
   proof failures and fresh/resumed runs; preserve Custom MCP receipts.
4. Platform route tests reject invalid proofs, unauthenticated identities and
   Preview personal-account access. No new persistence or credential exposure.
5. Publish an exact-head PR Preview VPS; check immutable release/health and run
   synthetic acceptance. Shared Preview cannot proxy personal Drive accounts.
6. Hand off personal-runtime acceptance: inventory, schema, approved bounded Drive
   metadata read in fresh/resumed Claude Chat. Record versions and actual outcome.

The gateway contract is shared by Electron Desktop, Web Desktop and Web Canvas.
No shell business logic is duplicated. Record live surface coverage separately.
Public support guidance and the harness support matrix live in this repository;
the private site documentation track is outside this support-fix scope.
