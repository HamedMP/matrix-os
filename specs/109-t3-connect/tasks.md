# Tasks

- [x] Define the direct-pair handoff, endpoint auth matrix, limits, and lifecycle owner.
- [x] Rebase clean Matrix OS and T3 Code worktrees on their current upstream main branches.
- [x] Add Matrix red tests for strict capability routing, HTTP header boundaries, WebSocket limits,
  repeat pairing, and loopback server fallback.
- [x] Implement the Matrix platform and gateway direct proxy.
- [x] Add upstream T3 red tests for path-prefixed pairing, discovery, OAuth, API, assets, WebSocket,
  and advertised pairing URLs.
- [x] Implement generic T3 reverse-proxy base-path support and `--pairing-base-url`.
- [x] Update T3 web/desktop/mobile copy and remote-access documentation for manual direct pairing.
- [ ] Complete focused tests, type checks, formatting, and review both diffs.
- [ ] Commit and force-push the rebased branches; update both existing PR descriptions and links.
- [ ] Deploy the exact Matrix bundle plus a test build of the T3 branch to the retained preview VPS.
- [ ] Pin the published upstream T3 version and perform desktop/mobile end-to-end verification.
- [ ] Open the separate Matrix OS public website documentation PR after upstream acceptance.
