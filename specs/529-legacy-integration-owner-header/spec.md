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
- The unsigned ID must exactly match the recorded owner. An invalid proof is
  never treated as a legacy request.
- Preview machines, shared machines, and unrelated actors continue to require
  valid signed delegation. Missing or invalid bearer tokens remain rejected.
- Existing signed delegation and provider action behavior are unchanged.

## Validation

1. Route tests cover the permitted legacy owner and rejected Preview, shared,
   unrelated-actor, and invalid-proof cases.
2. Platform builds and the related integration guard and delegation tests pass.
3. Production acceptance uses the affected runtime to list its integrations
   and run a read-only provider action after Platform capacity is healthy.

## Limits

The compatibility path cannot prove what bundle is installed on a remote
machine. It relies on Platform's existing per-machine bearer check and applies
only where the database says there are no collaborators. Newly shipped gateways
should continue signing delegated identities.
