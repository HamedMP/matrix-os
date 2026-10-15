# OpenClaw shared-browser authority

OpenClaw 2026.7.1 can compose hooks and discover tools from a different same-ID plugin registration than the registration attached to its gateway. Browser grants therefore belong to the attached gateway method registry. Registry-local hooks and tools relay to that authority through the existing authenticated native loopback WebSocket protocol.

## Authentication matrix

All methods below require the native gateway's `operator.admin` scope. The connection accepts only the existing string token from the native plugin API configuration, in memory, for `ws://127.0.0.1:18789/`. Remote gateways, TLS, password authentication, secret references, missing tokens, and other ports are unsupported and fail closed. No provider or platform credential supplies a fallback.

| Method | Additional authority |
| --- | --- |
| `matrix.browser.bind` | Exact run/session, bounded lease, optional binding nonce, and broker authentication before acknowledgement |
| `matrix.browser.revoke` | Exact run and binding nonce when supplied; never-dispatched reclamation retains its existing proof |
| `matrix.browser.before` | Trusted native run/session/tool-call context, exact action schema, authenticated active grant |
| `matrix.browser.execute` | One-use authority-issued ticket, same ticket as action nonce, exact session/tool call/action |
| `matrix.browser.cancel` | Same authority-issued ticket/nonce/session/tool call, checked even before execution |
| `matrix.browser.end` | Exact run and matching bound session |

Payloads use strict per-method schemas. The browser bearer stays in the authority and its fixed broker request. Native tool arguments contain only an opaque one-use ticket; neither browser nor native gateway bearer is returned to the model.

## Bounds and cancellation

The existing 64-run combined active/quarantine cap and 128-ticket cap remain. Queued tickets and pending actions share the latter cap. Tickets expire after ten seconds; grants expire within thirty minutes. Each registration has at most eight relayed actions, one lazy RPC connection, and the existing bounded cancellation correlation reserve. Browser RPC requests are capped at 64 KiB and responses retain the existing 1 MiB frame cap. Browser action calls use the broker action deadline plus ten seconds; cancellation RPCs use ten seconds.

Cancellation revokes the exact grant, preserves native bypass quarantine, aborts the authoritative plugin request and waits for its settlement before acknowledging. This acknowledgement does not prove that a physical Chrome action drained. The Matrix browser broker owns physical cancellation and reconciliation. Missing or malformed cancellation acknowledgement remains an unconfirmed cleanup failure during later retirement.

## Lifecycle

Native registry retirement closes only its relay and drains its relayed actions. It must not release grants held by another attached registry. The native service manager captures the authoritative registration's stop closure independently of later composed hooks; this stop revokes grants and drains pending plugin requests. Cleanup is idempotent, bounded, and fails closed on uncertain settlement.

A full native gateway method-registry replacement supplies one coherent new set of handlers. It does not copy authority from an old registry or use a same-session fallback. Missing grants remain unavailable.

## Qualification

Portable tests cover cross-registration relay, exact nonce and context checks, replay/capacity, cancellation races, unconfirmed cleanup, native connection policy, protocol framing, action deadlines, and captured service-stop semantics. A separate offline spike executes the captured native hook composition, gateway handler, method registry, and service manager bodies with the production entry and RPC client. Its peer and broker are synthetic; this establishes source compatibility, not a live model or invoice result.
