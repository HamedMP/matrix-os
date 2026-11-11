# Registered runtime routing for DevStack

Implements the Stage 2 routing boundary in [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack) and the [DevStack specification](https://github.com/HamedMP/matrix-os/pull/3023). This is a narrow follow-on to the local identity/bootstrap contract in #3157.

## Behavior

An operator registers a real worktree runtime before an engineer or agent uses it. Platform routes normal authenticated HTTP and WebSocket traffic to that registration without access to the host Docker API. The operator owns creation, start, stop and address placement. A request or agent prompt cannot choose an unregistered execution target. Each instance has its own database, credentials and private transport.

Select the profile with `MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY=true`, `PLATFORM_RUNTIME_MODE=local`, `MATRIX_DEVSTACK_INSTANCE=<slug>`, `MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED=true` and `PLATFORM_BACKGROUND_WORKERS_ENABLED=false`. The flag accepts only unset, `false`, or `true`. The profile rejects customer VPS orchestration, Preview-pair runtime mode and ATS database configuration. Existing startup and routing behavior is unchanged when this flag is unset or false. Do not initialize Dockerode, a live orchestrator, container lifecycle/stats workers, or a VPS provisioner in the profile. Reuse the disabled orchestrator for lifecycle requests.

The isolated Platform database is `matrixos_devstack_<instance>` (hyphens become underscores). Reuse the existing bootstrap slug and literal loopback database validation. The runtime additionally accepts a single `host` query option equal to `/run/matrix-devstack/<instance>/pg-proxy`, for an owned Unix Postgres forward. Reject duplicate or different query options, remote hosts, foreign database names, and namespace/path substitution. The bootstrap CLI's existing no-query, local-only contract stays unchanged. Validate configuration before opening a pool or constructing providers or workers. Never print a DSN or credential.

## Routing and authority

The existing bootstrap transaction remains the registration writer. It pins the actual immutable 64-hex container ID and the active owner with `devstack:<instance>:<clerk-user-id>`. The operator must verify that ID and its private DNS alias/network placement before registration and on replacement. Platform derives `matrixos-<registered-handle>` and uses the registered ports; it never accepts an upstream address from a request. Resolve only the registered logical `primary` runtime whose running row, active Platform user, handle, Clerk identity and instance owner marker agree. Missing/invalid IDs, stopped rows, wrong owner markers and missing registrations fail closed. Do not inspect or fall back to a Docker name, repoint a row, auto-wake a runtime, or return another instance on failure. Use a coherent read of the two existing registry tables. Keep HTTP and WebSocket consumers on the same resolver and existing timeout/redirect policy. Platform checks the registration, not live Docker identity; it cannot distinguish a replaced runtime if the operator repoints the private alias without updating its registration.

| Path | Existing authority | Additional profile requirement |
| --- | --- | --- |
| Authenticated app or `/vm/<handle>` proxy | Existing verified owner and entitlement checks; existing forwarded Gateway proof | Exact live registration in this instance's registry and fixed private alias |
| All computers, `GET/HEAD /runtime` | The hosted account manager signs in the browser and owns account-wide inventory | Signed requests resolve the registered owner; unsigned root requests can go directly to hosted sign-in |
| WebSocket upgrade | Existing session/owner and entitlement checks | Same registration lookup and target as HTTP |
| Create, wake, replace or stop | Existing route authentication | Disabled orchestrator; no host control calls |
| Legacy admin proxy, Code, Preview or VPS-specific forwarding | Existing behavior outside this profile | Unavailable in the registered-runtime profile |
| Offline bootstrap | Operator with access to the dedicated local DB | Existing transaction, owner marker and real immutable ID; no credit grant |

Existing auth, billing, funded-policy, and provider access rules stay in force. The profile neither enables funded AI nor requires changing the test account's Clerk project. No new endpoints, DB schema, host Docker/D-Bus access, public listeners, cloud resources or runtime deployments are required. Keep immutable source, owned data and operator privileges separate.

### Account computer manager

A registered preview's All computers link opens the canonical Matrix account manager. The registered profile returns a 302 to the fixed `https://app.matrix-os.com/runtime` URL with no request query, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`. The preview keeps serving the worktree at its registered URL. The separate Platform auth shell still serves the account manager in the normal Platform profile.

An unsigned root request gets the same redirect so the hosted manager can authenticate it. An unsigned `/vm/<handle>/runtime` gets 401. A signed request with a missing or foreign registration gets 404. Other methods get 405 with `Allow: GET, HEAD`. Test the exact redirect, unsigned root and scoped requests, wrong owner and handle, query stripping, and normal Platform routing. A registered preview should never proxy this page to an auth shell that serves a different inventory.

## Implementation and acceptance

1. Add failing tests for startup admission, unchanged legacy behavior and all no-orchestration properties. Cover an owned Unix DSN, foreign hosts/database/namespace/query, conflicting modes, invalid flag and workers enabled. Extract the shared bootstrap identity/DB validation into a small pure module; keep the existing bootstrap exports compatible. Only compose the validated result in the existing large startup function.
2. Add red/green tests through the real resolver and HTTP/WS consumers. Cover normal owner proof and live upstream forwarding, a stale/invalid ID, wrong instance/owner, stopped target, missing target and no Docker lookup or repair. Use the real registry query in PostgreSQL qualification; an in-memory substitute does not prove database wiring. Keep route composition changes small; put the policy and registry read in a focused module.
3. On the existing Dev host, use a fresh owned acceptance namespace and real Linux/x64 source. Start the registered runtime and Platform in isolated transport with no host control sockets. Bootstrap its actual ID into a dedicated database. Verify authenticated HTTP and WebSocket routing, negative owner/target cases and finite command feedback. Compare installed services/release and peer snapshots before/after; stop only owned resources, retain test data. No provider request, credit change, Main/installed Dev restart, or normal Web login claim from a programmatic auth test.
4. Deliver a reviewable draft PR linked to #3157 and ENG-432. Record exact source, red/green results and actual Stage 2 evidence. Update the separate site docs PR with supported configuration and limits. Terminal deployment, real Clerk Web login, funded settlement, multi-worktree hot updates and durable async result delivery have their own acceptance gates.

Keep the new authority check in `devstack-registered-runtime.ts` and database admission in `devstack-identity.ts`. When further routing behavior is needed, first extract registered app/explicit-VM transport composition from `session-routing-middleware.ts` into a focused registered-runtime proxy helper. Extract the Platform runtime/client composition from `platform-startup.ts` before adding another runtime mode. This keeps the current large composition files from becoming a second policy owner.
