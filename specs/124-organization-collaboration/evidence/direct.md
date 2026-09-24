# Relay, ticket and sandbox boundary evidence (S00 / T004)

Harness: `tests/integration/collaboration-direct-boundaries.integration.ts`, run with
`bun run test:integration -- tests/integration/collaboration-direct-boundaries.integration.ts`.

## Ingress paths at baseline `3b4662d28`

| Client | Ingress today | Notes |
| --- | --- | --- |
| Browser (Web Canvas, Web Desktop, Web Mobile) | `app.matrix-os.com` session routing → platform proxy (`packages/platform/src/collaboration/proxy.ts`) → customer VPS over self-signed TLS (`CUSTOMER_VPS_TLS_VERIFY=false`) | Platform signs `x-matrix-collaboration-proof` and forwards a signed policy header |
| Electron Desktop | Same platform origin; CSP is main-process injected and gateway-scoped | No hostname per user |
| Native Mobile / CLI | Same platform origin through existing 525 shared Chat/terminal | Recorded V1 limitation for new states. **Native Mobile's existing shared Chat/terminal do not reach the home as of 2026-09-24**: its sockets use the pre-direct path and are closed at the platform edge. CLI unaffected |
| WebSocket | Platform `websocket.ts` issues a one-use ticket bound to the policy revision and bridges frames | S05 moves verification to the home |

Customer VPS TLS: `distro/customer-vps/cloud-init.yaml:689` generates a 30-day self-signed certificate with
`CN=customer-vps.matrix-os.local`. No browser-trusted certificate or per-home hostname exists, which is why the
relay stays in the byte path (research.md R13).

## Relay byte-limit behavior

Current proxy timeouts are 10 s for APIs and 30 s for exports (`proxy.ts:259`). Body limits are enforced by the
home routes today; the relay-side coarse byte and connection limits from contracts/organization-api.md (96 KiB JSON,
64 KiB WS frame, 256 connections per home) do not exist yet and are an S05/T103 deliverable.

## Required supervisor facilities (asserted statically, always run)

`packages/scope-runtime/src/profile.ts` `FIXED_SYSTEMD_PROPERTIES` must keep: `DynamicUser=yes`, `PrivateUsers=yes`,
`PrivateNetwork=yes`, `ProtectHome=yes`, `ProtectSystem=strict`, `ProtectProc=invisible`, `ProcSubset=pid`,
`NoNewPrivileges=yes`, empty `CapabilityBoundingSet`, `RestrictNamespaces=yes`, `MemoryMax`, `TasksMax`,
`RuntimeMaxSec`, a `RootDirectory`, and no bind of `.codex`, `.claude`, `.config/gh`, `.ssh`, `.netrc`,
`git-credentials` or `host.env`. The only writable runtime binds are the broker socket, readiness file and command
directory. S07 must extend this profile for project-root mounts without weakening any listed property.

## Probe ledger (last run 2026-09-20, no live fixtures)

| Probe | Fixture | Outcome |
| --- | --- | --- |
| Platform proxy performs per-request policy decision and body parsing (baseline S18 must invert) | none | pass (characterizes current state) |
| Platform WebSocket bridge requires a platform policy | none | pass (characterizes current state) |
| Scope-runtime profile isolates network, home, credentials, privileges | none | pass |
| Scope-runtime profile binds no credential or forge paths | none | pass |
| Authenticated read reaches the home through the relay | `COLLABORATION_PROBE_RELAY_URL`, `_SESSION_TOKEN`, `_SCOPE_ID` | unrun: fixture missing |
| Forged proof header is rejected with a generic body | same | unrun: fixture missing |
| WebSocket upgrade with foreign Origin refused | same + `COLLABORATION_PROBE_ALLOWED_ORIGIN` | unrun: fixture missing |
| Oversized body refused | same | unrun: fixture missing |
| Owner credential files unreachable from the sandbox | `COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1` on a root systemd host | unrun: fixture missing |
| Other processes' environments invisible | same | unrun: fixture missing |
| Outbound network denied | same | unrun: fixture missing |
| Host Git object stores unreadable | same | unrun: fixture missing |

Live relay and sandbox probes need one disposable enrolled VPS (Hetzner spend requires owner approval) and a Clerk
session for an organization member. Until they run, "relay transparency" and "sandbox escape denial" in
quickstart.md remain open gates.
