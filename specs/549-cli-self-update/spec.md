# Matrix CLI self-update

Ticket: [ENG-315](https://linear.app/matrix-os/issue/ENG-315/add-matrix-update-for-reliable-cli-upgrades), child of ENG-299.

## Goal and behavior

An older standalone CLI can lack `matrix preview`. Add `matrix update` to install
the newest stable CLI release and `matrix update --check` for a read-only check.
This command updates the local CLI only; it never updates a Matrix computer,
promotes a channel, restarts Electron, or changes saved profiles and logins.

## Invariants

- Release authority: the official HamedMP/matrix-os GitHub releases, stable
  `cli-vX.Y.Z` tags only. OS releases and prereleases never qualify. The bounded
  catalog read fails closed when no CLI release is present.
- Standalone macOS/Linux x64/arm64: verify the exact asset URL, SHA-256 manifest,
  bounded binary, and executable version before atomic replacement. Verify
  again after installation and restore the original when validation fails.
- Cooperating updates share an exclusive installation lock. Reject executable
  symlinks/hard links and detect changed target identity before publishing.
  Same-user/root writers that bypass that lock remain within the local trust
  boundary. Preserve recovery copies if another process replaces the target.
- Temporary files are removed on completion. A crash leaves the exclusive lock
  for deliberate owner recovery, preventing repeated staging. At most four
  retained rollback files are allowed before manual recovery is required.
- Homebrew and recognized pnpm global installs delegate to their package manager
  and verify the installed version afterward. Source trees and other managed
  installations return actionable guidance without replacing Node or packages.
  npm packaging remediation remains ENG-300.
- No authentication or provider files are read by this command. Downloads carry
  no Matrix credentials. Every external request and child process is bounded;
  GitHub asset redirects accept only the official download infrastructure.

## Verification and delivery

1. Run integrity, rollback, concurrency, release-selection and CLI behavior
   regressions on the disposable VPS; local dev servers and Electron stay closed.
2. Run focused existing CLI tests and TypeScript checks remotely, then hosted CI.
3. Capture real CLI help/check output; other product surfaces have no changed
   code or capability. Recommend CLI-maintainer review of install behavior.
4. Update the CLI README and a separate matrix-os-site documentation PR under
   `content/docs/`, linking both from ENG-315.
5. Obtain current-head Greptile 5/5 and add ready-for-ci. Publication follows
   the normal reviewed CLI release procedure; no automatic release is requested.
