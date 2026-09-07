# Terminal session ownership

Matrix customers do not need SSH access to use their computer. Normal terminal
access happens through a Matrix surface, and the gateway attaches that surface
to the named Zellij session on the customer's VPS.

This document defines which attachment paths participate in coordinated live
presentation ownership and records the deployment assumption behind the
in-memory lease coordinator.

## Supported attachment paths

The following clients participate in gateway-coordinated ownership:

- the focused browser Terminal in Canvas or Desktop mode, including the mobile
  web shell;
- the native desktop app's Terminal tab;
- the focused native mobile Terminal tab; and
- the Matrix CLI using `mos shell attach <session>`.

For example, attach the local CLI to the same `main` session shown by Matrix:

```bash
mos shell attach main
```

These clients authenticate to `/ws/terminal/session`, request an exclusive
lease when focused, renew the lease while idle, and honor revocation. A named
session has one live presentation owner at a time. The owner controls input and
the canonical rows and columns; another renderer must explicitly resume the
session to transfer ownership. Lease expiry fails closed and does not make a
background observer writable.

The native mobile client declares its measured xterm grid as a hard renderer,
releases ownership when its Terminal tab loses focus or the app backgrounds,
and reacquires ownership when the user returns. If another renderer takes over
while mobile is visible, mobile closes the displaced socket and requires an
explicit **Resume here** action before it requests a new exclusive lease.

## Compatibility with sessions created before an update

The shared gateway adapter attaches with `options --default-mode normal`.
Zellij 0.44 initializes the attached client's current mode from the running
server's saved configuration, while interpreting keys against the new client's
default-mode options. If a server saved Normal and an updated client defaults
to Locked, unbound ordinary keys become no-ops. Paste follows a separate action
path and can still work, making the terminal appear to freeze after pasting.

Normal is the attachment fallback for both supported saved modes: Normal then
writes unbound keys, and Locked always writes them regardless of the fallback.
New Matrix sessions still start Locked. This override changes neither session
identity nor running processes, and all gateway-coordinated surfaces inherit it.
Do not remove it merely because a newly created session passes a typing test.

The host-bundle build runs `scripts/smoke-zellij-session-config.ts` against its
staged Zellij binary. It creates isolated servers with Normal and Locked saved
configurations, attaches through the real gateway adapter using the updated
configuration, and checks typing, backspace, paste, and repeated attachment
without replacing the pane process. Run it locally with:

```bash
pnpm exec tsx scripts/smoke-zellij-session-config.ts /absolute/path/to/zellij
```

An affected running session needs a fresh gateway attachment after the fixed
gateway is installed. Closing a Terminal window alone does not restart its
durable shell, and deleting/recreating sessions is unnecessary for this defect.

## Direct Zellij attachment

`zellij attach <session>` talks directly to the Zellij server and bypasses the
Matrix gateway. It therefore cannot participate in gateway lease acquisition,
heartbeat renewal, epoch fencing, canonical-size coordination, or renderer
revocation.

Direct Zellij attachment is an operator/developer diagnostic path, not a normal
customer workflow. Do not use it when validating cross-surface handoff, and do
not recommend it in customer support instructions. Use the coordinated CLI
command instead:

```bash
mos shell attach <session>
```

Because the VPS owner controls their machine, Matrix cannot make the raw
Zellij binary cryptographically inaccessible. An operator who deliberately
bypasses the gateway accepts that the direct client may disturb presentation
state or dimensions.

## Gateway topology and distributed leases

The current production topology has one authoritative gateway process per
customer VPS. Terminal leases are consequently bounded, ephemeral, in-memory
state in that process. Zellij remains the durable source of truth for the
session and running programs; losing gateway lease state does not terminate the
Zellij session.

Do not run multiple gateway processes against the same customer's Zellij
runtime with the current coordinator. Separate gateway processes would have
independent lease maps and could each believe a different renderer owns the
same session.

Before introducing multiple gateway replicas for one runtime, replace the
process-local coordinator with a shared authority that provides all of the
following:

- atomic acquisition with one monotonically increasing fencing epoch;
- holder-and-epoch-conditional renewal, resize, and release;
- bounded expiry that remains fail closed;
- revocation delivery to sockets connected through every gateway replica; and
- one shared canonical terminal size and serialized presentation cutover.

Postgres, Redis, or another shared coordinator may implement that authority,
but the correctness contract above matters more than the storage choice. A
multi-gateway rollout is blocked until integration tests prove that connections
split across replicas still select exactly one writer and one presentation
size.

## Intentional presentation constraint

One Zellij session cannot provide independently reflowed live grids at two
different sizes. Matrix therefore transfers presentation ownership instead of
trying to render two simultaneously writable layouts. Background renderers are
read-only and offer an explicit resume action; resuming recreates the gateway's
Zellij attach bridge at the new owner's dimensions.
