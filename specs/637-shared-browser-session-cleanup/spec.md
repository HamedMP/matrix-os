# Shared browser session cleanup (ENG-396)

## Goal and confirmed cause

Prevent ordinary iframe creation from turning a healthy Chrome window into an
unavailable automation session. The bug is in the shared backend used by every
Browser surface; this change introduces no renderer, copy, or layout changes.

A disposable Chrome reproduction of YouTube exposed two linked faults:

1. A newly paused out-of-process iframe is reported with an empty initial URL.
   URL validation rejects it before Fetch interception is installed, requesting
   an unnecessary owner handoff.
2. Automatically attached flattened child sessions belong to their emitting
   parent session. Sending `Target.detachFromTarget` on the browser root returns
   `-32602: No session with given id`. Handoff cleanup consequently fails and
   the broker enters `unavailable` instead of enabling owner control.

Nested sessions must also be released before disabling their parent's automatic
attachment, which otherwise implicitly detaches those descendants.

## Behavior and boundaries

- Record each child session's emitting parent and use it to route detach.
- Release descendants before their parents, without changing owned-tab authority.
- For newly paused page/iframe targets, allow the exactly empty initial URL as
  a pre-navigation state. Install Fetch interception and service-worker bypass
  before resuming; validate every subsequent network request as before.
- Keep existing-worker and unsupported-target handoffs, owner control gates,
  request limits, deadlines, and no-replay semantics intact. Do not swallow
  protocol errors or classify arbitrary InvalidParams errors as success.
- State is bounded and ephemeral; child records clear on detach/disconnect/run
  cleanup. No database, credentials, endpoint, or permission changes.

## Verification

The session regression suite exercises the production CDP client and driver
through a wire fixture that rejects child detaches addressed to the wrong
parent. It covers a direct iframe, duplicate attachment, nested descendants,
empty-URL request gating, and broker handoff/resume without action replay.
The original CDP suite retains its existing transport and security assertions;
its Chrome fixture is extracted into a shared helper.

Disposable real Chrome checks compare the installed baseline and patched source:
- Public YouTube: reproduce the empty iframe and root-addressed detach error;
  confirm cleanup succeeds with the patch. Unsupported service workers still
  cause an intentional handoff, so this is not an unattended YouTube qualification.
- Local nested cross-site iframe fixture: baseline handoff/detach fails; patched
  source loads both descendants, returns a snapshot, and acknowledges cleanup.
  Fixture-only DNS/socket injection isolates this browser from the owner's profile
  and production automation connection; it does not qualify production networking.

Affected Browser renderers share this backend. No live frontend evidence or
production rollout is claimed. Ask the Browser/security maintainer to review
session ownership and the pre-navigation interception invariant before merge.

## Deferred scope

ENG-396 still tracks unavailable-state recovery, error-message/diagnostic changes,
the eight-tab capability limit, and any expansion of supported worker automation.
Those are separate from this session-lifecycle fix. Ship through a reviewed PR
and normal host-bundle release; do not patch the running customer gateway.
