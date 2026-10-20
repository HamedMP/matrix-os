# Browser viewer focus and cleanup recovery

## Problem

Electron Desktop sends native Browser and Cloud desktop activation changes into
the shared browser surface. Previously, every loss of focus aborted the viewer
lifetime and removed its iframe. Returning forced a new authenticated admission
and RFB connection. A separate driver cleanup failure could leave a completed
agent run unavailable: a protocol error from its recorded document could leave
the CDP socket open, causing detach to fail before trying a fresh connection.

## Behavior

An initially inactive surface does not connect. Once activated, it retains its
viewer across ordinary focus changes. Inactive frames remain inert, have no
pointer input, and cannot dispatch native commands or automation controls. On
return, a new status response for that focus epoch is required before input is
enabled. Background surfaces do not renew viewer admission or claim the browser
from a foreground surface. An expired or lost stream can be replaced on return;
explicit disconnect/reconnect behavior is otherwise unchanged. Runtime changes,
auth lifetime changes through host unmount, and unmount destroy the old lifetime.

When cursor cleanup fails on the existing driver transport, close that transport
and try the existing fixed-endpoint cleanup path once. Only a successful cleanup
acknowledgement allows the broker to restore owner input and clear the completed
run. Failure leaves the broker unavailable. Recovery never replays an action,
opens an owner tab, or clears a failure merely to make the UI appear usable.
Protocol diagnostics record only the validated method name and numeric error
code, excluding raw protocol messages, parameters, page contents and credentials.

## Security and persistence invariants

- No new endpoint, IPC channel, permission or persisted state is introduced.
- Existing owner authentication, app-scoped cookies and viewer tickets remain
  the authority. Focus is never authority to grant input.
- Browser/Cloud desktop admission remains exclusive; a background surface cannot
  automatically reclaim it.
- Existing broker control serialization and driver ownership scopes remain intact.
- Failed physical cleanup remains a valid unavailable state. Owner input is not
  enabled optimistically after a failed recovery.

## Wiring and validation

The change is shared by Web Canvas, Web Desktop and Electron Desktop through
BrowserSurface/useBrowserSurface. Native activation messages and iframe source /
origin checks remain unchanged. Mobile consumers of this shared surface inherit
the same connection and input behavior where present.

Regression checks cover retained iframe identity, inactive input gating, a fresh
foreground authority check, initial inactive mount, runtime replacement, background
expiry, late admission, and no background claims. Driver checks cover protocol
cleanup failure on a still-open socket, fresh acknowledged recovery, failed fresh
cleanup, and one acknowledged action rather than replay. Existing broker tests
cover fail-closed recovery and serialized input-gate release.

## Release and deferred validation

This patch requires normal code review and a host-bundle deployment before live
verification. A successful local suite is not proof that an expired Preview or
the previously failed live run has recovered. The exact historical CDP error
remains unconfirmed; the new sanitized diagnostics make it observable if repeated.
Intermittent viewer admission failures and black frames remain separate open
validation items.

A separate documentation PR in FinnaAI/matrix-os-site/content/docs is a release
deliverable for the new focus/reconnect behavior. It is deferred alongside remote
PR publication under the current no-CI/no-deployment scope. No site copy is
introduced into this repository.
