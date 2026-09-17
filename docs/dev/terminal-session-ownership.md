# Terminal session ownership

Matrix customers do not need SSH access to use their computer. Normal terminal
access happens through a Matrix surface, and the gateway attaches that surface
to a canonical terminal workspace/tab on the customer's VPS.

This document defines which attachment paths participate in coordinated live
presentation ownership and records the deployment assumption behind the
in-memory lease coordinator.

## Supported attachment paths

The following clients participate in gateway-coordinated ownership on
`/ws/terminal/tab`:

- the focused browser Terminal in Canvas or Desktop mode, including the mobile
  web shell;
- the native desktop app's Terminal tab;
- the focused native mobile Terminal tab; and
- the Matrix CLI using `mos shell attach <session>`.

For example, attach the local CLI to the same `main` session shown by Matrix:

```bash
mos shell attach main
```

These clients request an exclusive lease when active and honor revocation. A
workspace/tab has one live writer at a time. When another device takes over,
the old graphical surface stays attached to the shared runtime stream and
continues to render output, but the gateway rejects its input, binary input,
and hard resize frames. The observer shows **Live on another device** with a
**Continue here** action. That action establishes a fresh exclusive attachment
and transfers write authority. A displaced CLI attachment exits because it has
no persistent observer UI.

Transport reconnect and ownership transfer are separate states. A revoked
observer reconnects with `lease=observe`, remains read-only, and keeps
following output. It must not reclaim the terminal merely because its network
connection recovered. This distinction prevents two open Matrix surfaces from
repeatedly stealing ownership and presenting the handoff as terminal
instability.

Web Mobile and Native Mobile use the same writer/observer semantics. If another
renderer takes over while mobile is visible, mobile keeps the displaced socket
as a read-only output observer and requires an explicit **Continue here**
action before it requests a new exclusive lease.

## Startup input bursts and admission

Terminal startup can produce hundreds of legitimate xterm protocol replies,
including the 256 indexed-color replies. These travel through the same input
path as typing. Closing a connection merely because 33 replies arrive before
asynchronous admission finishes creates a reconnect/redraw loop.

Gateway and runtime socket admission use a shared bounded FIFO. Adjacent text
or binary input for the same terminal reference may coalesce into batches of
at most 64 KiB of input bytes. Batches never cross input encoding, terminal
reference, resize, ping, or detach boundaries. The queue retains at most 32
batches (including the in-flight batch) and 1 MiB of serialized frames. Overflow
still closes the connection; gateway telemetry records `input-overflow` without
input content, and the WebSocket closes with status 1013.

Coalescing is not an authorization shortcut. Every gateway batch passes the
existing project admission and current live-ownership checks immediately before
forwarding. Disconnect, overflow, or admission failure clears pending work;
queued input cannot migrate to a replacement connection. The runtime also
buffers startup replies until native attachment is ready, then processes frames
in order. A client disconnect during attachment must release the late viewer.

Regression checks:

```bash
TMPDIR=/tmp pnpm exec vitest run tests/terminal-runtime/input-frame-queue.test.ts tests/terminal-runtime/startup-input-burst.test.ts tests/terminal-runtime/socket-api.test.ts
```

For live verification, repeatedly create a Terminal, type immediately after the
prompt appears, paste text, switch tabs, and transfer ownership between clients.
Capture startup reply frames without terminal contents; 33 and 259 legitimate
small replies must preserve attachment and subsequent keyboard input. Verify
that an observer still cannot type and control-frame/byte floods remain bounded.

## Compatibility with tabs created before an update

The terminal runtime's Zellij adapter attaches with `options --default-mode normal`.
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
configuration, and checks typing, backspace, paste, and repeated/indexed
attachment without replacing the pane process. A supervisor owns the temporary
directories and session cleanup, including when the test worker times out or
is interrupted. Run it locally with:

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
state in that process. The terminal workspace runtime remains the durable
source of truth for tabs and running programs; losing gateway ownership state
does not terminate them.

Do not run multiple gateway processes against the same customer's terminal
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

One shared terminal tab cannot provide independently reflowed live grids at two
different sizes. Matrix therefore transfers presentation ownership instead of
trying to render two simultaneously writable layouts. Background renderers stay
attached as read-only observers and offer an explicit **Continue here** action.
