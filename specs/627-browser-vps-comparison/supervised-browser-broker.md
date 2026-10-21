# Supervised shared Chrome: broker and native wiring

Depends on authority layer #2662. The shared permission experience and public
documentation remain a separate dependent layer. Production stays default-off.

## Execution and ownership

The Gateway registers personal Codex/Claude supervised runs with a fixed
owner/runtime controller before starting the native adapter. Native discovery
receives only the fixed shared-browser MCP server. Each browser lease captures
its server-created policy; model tool arguments cannot change it. The same gate
applies to direct capability calls before physical driver dispatch.

An exact parsed action produces a metadata-only challenge and digest. The
canonical Chat activity records its scope and expiry. Only an online-verified
platform owner proof can resolve it. The owner database conditionally consumes
that challenge, or the exact current Chat grant revision, before the broker
checks control revision again and dispatches. Browser content is untrusted.
Status queries expose control metadata and do not observe page content.

Pause, takeover, Stop, signal cancellation, expiry and run shutdown fence waits.
Resume takes a fresh snapshot rather than replaying a pending mutation. A failed
decision acknowledgement ends the affected call if consent may already have
been consumed. It never silently retries Chrome.

## Auth matrix

| Route | Authentication | Browser authority |
| --- | --- | --- |
| Existing browser agent-action POST | Live owner/Chat/run/harness capability | Captured lease policy and exact consumed challenge/grant |
| Existing canonical approval POST | Existing authenticated owner route | Distinct platform-signed browser proof, verified online |
| GET `/api/chats/:chatId/browser-grants` | Existing owner principal | Owner-scoped active metadata only |
| DELETE `/api/chats/:chatId/browser-grants/:grantId` | Existing owner principal | Separate signed revoke tuple, revision CAS |

No Gateway-held machine credential can sign owner intent. Undo works after the
originating run ends, and revocation fences later grant consumption. The grant
covers the same signed-in Chrome profile; it does not claim a per-site or
credential-page exclusion. Existing browser credential-control handoff remains
independent.

## Resource and shutdown bounds

The controller admits at most 64 live runs, one pending decision per run, and 64
bounded metadata-only retry receipts per run. Run expiry is 30 minutes; decision
waits are at most five minutes. The broker retains its existing 16-action queue.
Owner PostgreSQL and platform verification have separately bounded pools and
timeouts. Shutdown cancels waits, invalidates epochs, drains the browser and
closes only owned pools. Expired metadata cannot recreate a browser action.

## Native permission transport

Only the fixed broker tool avoids a second generic native permission prompt.
Codex uses the documented per-tool MCP approval override; Claude uses an exact
`--allowedTools` entry. Neither changes other tool permissions or authorizes a
browser action. The independent broker gate still applies. Unsupported policy
or missing authority denies execution.

Primary references: [Codex configuration](https://developers.openai.com/codex/config-reference),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

## Validation and remaining acceptance

The original three supervised admission/dispatch cases failed semantically
before implementation. Native configuration assertions also failed before the
fixed-tool overrides. Functional integration covers each native harness through
the real canonical owner route, platform signature verification, metadata
consumption, remembered grant and signed Undo. Forged proof never reaches Chrome.
Concurrent transaction acceptance still requires the real disposable PostgreSQL
CI job from layer A; an embedded functional fixture is not that race evidence.

Local dev servers and Electron remain closed. Live permission cards, the exact
platform preview proof path, model invoice acceptance, Web Canvas/Web Desktop
and hosted Electron parity remain required before enabling the feature. Layer C
must include public-site guidance and Figma evidence without claiming those
checks passed in advance.
