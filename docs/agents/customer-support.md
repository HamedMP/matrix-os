# Customer Support Agent Notes

This repo is public. Keep support guidance here limited to behavior, safety
invariants, and escalation boundaries. Do not add customer identifiers, IP
addresses, private hostnames, billing IDs, tokens, or incident-specific
commands. Private runbooks belong in the private support system or the relevant
secret manager.

## Machine Resize Support Boundary

Matrix OS has a platform-internal customer VPS resize primitive:
`POST /vps/:machineId/resize`.

Use it as a support or platform-automation primitive, not as a direct customer
self-serve control. The route is protected by platform auth and performs a
Hetzner in-place server type change using a guarded state machine:

- claim the machine from `running` to `resizing` before provider mutation
- gracefully shut down first, with hard poweroff only as a bounded fallback
- call Hetzner `change_type` with `upgrade_disk: false`
- wait for the resize to settle, power on, and complete back to `running`
- leave ambiguous accepted provider actions in `resizing` for reconciliation

## Compatibility Rules

Hetzner local root disks cannot shrink. A support resize must reject smaller
disk targets before shutting down a customer VPS.

Current public plan shape:

| Current type | Safe data-preserving target |
| --- | --- |
| `cpx22` | `cpx32`, `cpx52` |
| `cpx32` | `cpx52` |
| `cpx52` | none in the default plan ladder |

Do not present unsupported downgrades as customer self-serve. If a customer
needs a lower plan after their root disk has grown beyond the target type, that
is a migration project rather than an in-place resize.

## What Agents Should Say

- Safe phrasing: "We can upgrade an existing Matrix computer in place when the
  target machine has at least as much local disk as the current one."
- Safe phrasing: "Downgrades that would shrink the root disk need a migration
  path and are not supported by the current in-place resize primitive."
- Unsafe phrasing: "Any plan can be upgraded or downgraded without constraints."
- Unsafe action: publishing private operator steps, API tokens, customer host
  names, or incident-specific evidence in this public repo.
