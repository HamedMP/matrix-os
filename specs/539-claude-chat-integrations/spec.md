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
