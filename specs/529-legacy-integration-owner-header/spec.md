# Legacy integration owner header compatibility

## Problem

Older customer gateways forward `x-platform-user-id` without an
`x-platform-verified` proof when an agent calls an integration. Platform's
internal integration route now requires a proof whenever either identity header
is present, so these gateways receive 401 before connection lookup. An active
connection in Platform does not help while the request is rejected at this
boundary.

## Required behavior

- A valid per-machine bearer and an unsigned owner ID may resolve to the
  machine owner only for a running, single-user customer machine.
- The unsigned ID must exactly match the recorded owner. A present proof,
  including an empty or invalid value, is never treated as a legacy request.
- Preview machines, shared machines, and unrelated actors continue to require
  valid signed delegation. Missing or invalid bearer tokens remain rejected.
- Existing signed delegation and provider action behavior are unchanged.

## Security architecture

| Route on `/internal/containers/:handle/integrations` | Authentication and owner scope |
| --- | --- |
| `GET /`, `/available`, `/agent-catalog`, `/:id/status`, `/apps`, `/apps/:appId` | Handle-bound machine bearer, then owner or verified delegate; downstream route authorization remains in force. |
| `POST /sync`, `/connect`, `/call`, `/webhook/connected`, `/:id/refresh`, `/apps` | Same machine and actor checks before the existing body and action validation. |
| `PATCH /:id`; `DELETE /:id` | Same machine and actor checks before existing mutation validation. |

The Platform route validates the handle pattern and compares the bearer with
the handle-bound HMAC in constant time before looking up the running machine.
It then uses the machine record as the owner and classification source of truth.
The compatibility case requires the unsigned `x-platform-user-id` to equal
that owner exactly, a *missing* `x-platform-verified` header, customer
classification, and an empty collaborator list. A present empty or invalid
proof fails closed. Every other delegated actor needs a valid handle-bound
proof and machine access; the Preview and shared-machine rules are unchanged.
No request header can choose a different owner through the compatibility case.

The existing Platform secret remains in server configuration and the gateway's
internal bearer. Neither secret nor proof is placed in URLs or logged. Invalid
handle, missing configuration, invalid credentials, inaccessible actors, and
unknown machines retain their existing bounded 400/503/401/403/404 responses;
provider details are not added to these responses.

## Integration wiring

At startup, Platform creates its integration routes and mounts them under the
internal path in `createApp`. The existing internal guard runs after bearer
verification and before machine lookup and actor resolution. A kernel tool or
host integration command calls the local gateway's `/api/integrations` route;
the gateway authenticates that local caller and proxies to the internal
Platform route with its machine bearer. Current gateways sign the authenticated
actor. Older gateways forward the owner's unsigned header. Platform resolves
the authorized actor to its integration user before account lookup or provider
dispatch. This change adds no service, secret, startup step, or cross-package
state channel.

## Failure modes and resources

- A wrong bearer, wrong owner, present invalid proof, shared machine, or
  Preview machine cannot enter the legacy path. A missing or non-running
  machine has no legacy owner scope; database errors do not grant access.
- The existing gateway proxy has a 30-second fetch timeout. Downstream action
  timeout and error propagation are unchanged; a provider failure cannot be
  mistaken for successful owner resolution.
- Identity selection makes no writes or persistent state. Each request reads
  current machine classification and collaborators, so a later request sees
  access changes. A crash requires no compatibility-state recovery.
- The existing gateway and internal guard each cap proxied bodies at 64 KiB.
  The guard keeps its per-instance in-flight limit, token buckets, capped
  handle map, and expiry. This change adds no buffer, map, timer, or file and
  does not change what data an authorized provider action sends downstream.

## Validation

1. Route tests exercise the real Platform middleware from bearer admission
   through actor selection, covering the permitted legacy owner and rejected
   Preview, shared, unrelated-actor, empty-proof, and invalid-proof cases.
2. Gateway delegation and Platform guard tests, the Platform build, and
   exact-head CI pass. Platform Preview starts from the same head.
3. The full gateway-to-Platform-to-provider checkpoint uses the affected
   runtime after deployment: list integrations and complete one read-only
   provider action while Platform capacity is healthy.

## Limits

The compatibility path cannot prove what bundle is installed on a remote
machine. It relies on Platform's existing per-machine bearer check and applies
only where the database says there are no collaborators. Newly shipped gateways
should continue signing delegated identities.
