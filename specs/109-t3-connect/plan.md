# Implementation Plan

## Matrix OS PR

1. Extend the bounded Terminal launch registry with `t3-connect`, a pinned owner-scoped command,
   and an explicit confirmation before execution.
2. Parse the action only when `launch=__terminal__` and queue it without creating a synthetic
   built-in path.
3. Wire the action through ShellHome to Canvas/Desktop and the mobile shell.
4. Preserve only the fixed handoff across sign-in, billing, and provisioning routing, then consume
   it after queueing.
5. Cover query validation, auth/billing retention, replay prevention, queue behavior, and mobile
   launch behavior with focused tests.

## T3 Code PR

1. Export one shared Matrix OS handoff URL for every client.
2. Add a Matrix OS row to web/desktop Connections settings.
3. Add a Matrix OS option to the mobile Add Environment screen.
4. Use each client's existing external-link API and generic failure handling.
5. Document the Matrix OS path in T3's remote-access guide.

## Rollout

The Matrix OS PR can land independently and safely ignores unknown actions before it ships. Land
Matrix OS first, then T3 Code. The T3 button becomes functional as soon as the user's Matrix runtime
contains the Matrix OS change.

## Documentation

This repository contains the implementation specification. T3's user-facing remote-access guide is
updated in the paired upstream PR. A short public Matrix OS guide belongs in the separate website
repository and should link to T3's official client downloads once the upstream Settings entry ships.
