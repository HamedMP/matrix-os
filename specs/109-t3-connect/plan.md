# Implementation Plan

## Matrix OS PR

1. Preserve the existing fixed Terminal handoff across auth, billing, provisioning, and both shell
   renderers.
2. Replace managed T3 Connect setup with a pinned direct-pair command that validates the Matrix
   handle, uses owner-scoped state, binds to loopback, and advertises the explicit-VM proxy URL.
3. Add a credentialless platform capability for only the T3 descriptor, OAuth, API, and WebSocket
   paths. Select an active VPS by explicit handle without forwarding Matrix credentials.
4. Add a gateway HTTP/WebSocket proxy with a fixed `127.0.0.1:3773` target, exact path and header
   filters, body/frame/queue/connection caps, upstream timeouts, and shutdown draining.
5. Verify strict routing, T3 credential preservation, Matrix credential stripping, repeat setup,
   server fallback, and proxy cleanup with focused tests.

## T3 Code PR

1. Preserve URL path prefixes when normalizing paired HTTP and WebSocket environment bases.
2. Resolve discovery, OAuth, API, assets, and WebSocket paths below that prefix.
3. Add a generic `--pairing-base-url` option to `t3 serve` and `t3 pair` so a trusted reverse proxy
   can advertise a different public URL from the listening socket.
4. Keep the shared Matrix setup entry in web/desktop and mobile, but describe the manual scan/paste
   flow and remove relay-discovery polling added for the earlier design.
5. Document path-prefixed reverse proxies and Matrix direct pairing in T3's user and internal docs.

## Rollout

The Matrix runtime command is pinned to the first official T3 release containing the generic
reverse-proxy support. Until that package is published, test the paired branches together and keep
the Matrix PR dependent on the upstream T3 PR. After release, deploy an exact Matrix host bundle to
the retained preview VPS and verify desktop plus mobile pairing before promotion.

## Documentation

This repository contains the implementation and security specification. T3's remote-access docs are
updated in the upstream PR. A separate public Matrix OS guide in `FinnaAI/matrix-os-site` remains an
explicit deliverable after the upstream UX and package version are accepted.
