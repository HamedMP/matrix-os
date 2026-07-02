## Summary

Design proposal for first-class Matrix OS contributor workspaces on user VPSes.

The proposed workflow makes Matrix-in-Matrix the first test case, but generalizes to day-to-day Matrix OS development:

- local-first `mos dev up --path <repo> --name <instance>`
- automatic repo detection
- non-conflicting dev ports
- multiple isolated dev instances
- local Matrix CLI forwarding by default
- optional public `mos dev expose` previews
- agent guidance for the preferred development path
- future terminal surface direction (TermX / WASM Ghostty / native shell)

Review requested: @HamedMP

## Why This Should Be A PR First

This crosses CLI UX, VPS runtime shape, public preview strategy, agent behavior, and contributor docs. A PR gives us a reviewable artifact with concrete decisions and follow-up tasks before implementation. A GitHub Discussion could be useful for broader brainstorming, but the design is specific enough to start as a docs/spec PR.

## Invariants

### Source of truth

- VPS-side instance metadata should become the canonical source of truth for dev instances.
- Local CLI state should cache active forwards only.
- Repo checkouts remain source of truth for code; generated per-instance env should live outside the repo by default.

### Lock/transaction scope

- Implementation should allocate ports and persist instance metadata atomically.
- Docker compose startup can happen after metadata write, with health/status reconciliation on failure.
- Public tunnel provisioning should be a separate transaction from local instance startup.

### Acceptable orphan states

- Metadata exists but container startup fails: `mos dev doctor` and `mos dev rm` must recover.
- Container exists but local forward fails: instance remains healthy; CLI reports forwarding failure.
- Public hostname exists but tunnel fails: local mode still works; expose state is degraded and recoverable.

### Auth source of truth

- Local forwarded development binds to localhost and relies on the authenticated Matrix CLI/session transport.
- Public previews must use platform-owned authz and should not expose unauthenticated dev shells by default.

### Deferred scope

- This PR does not implement `mos dev` commands.
- This PR does not ship tunnel provisioning.
- This PR does not choose TermX vs WASM Ghostty vs native terminal implementation.
- This PR does not alter production/customer VPS ports.

## Testing

Docs/spec only. No runtime tests required for this design PR.

Implementation follow-ups will need tests for repo detection, instance naming, port allocation, metadata persistence, compose env generation, local forwarding, multi-instance isolation, and public preview authz.

## Notes

This design should also update agent guidance after acceptance so coding agents prefer `mos dev` over manual Docker/nginx/Cloudflare steps when contributing to Matrix OS on a VPS.
