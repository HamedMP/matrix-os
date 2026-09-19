# Independent Desktop / VPS compatibility

Supersedes the removal-only scope of PR #1626. Stable Desktop releases and VPS
host bundles ship independently. Git ancestry remains support provenance, not
a compatibility or update requirement.

## Decision table

| Running gateway information | User behavior |
|---|---|
| Supported base protocol, any commit/channel | Workspace opens normally; channel updates stay optional |
| Desktop protocol below gateway minimum | Dismissible Desktop update guidance |
| Desktop protocol above gateway maximum | Dismissible cloud update guidance |
| No handshake on a legacy gateway | Keep working; compatibility unverified |
| Invalid handshake, offline, 502 | No misleading update modal; check remains unavailable |

## Invariants

- Source of truth: running gateway protocol window and compiled Desktop protocol.
  Installed release metadata cannot override the running service contract.
- No new endpoint, persistence, lock or transaction. Existing authenticated
  system-info/update APIs and main-process Desktop updater remain authoritative.
- Requests remain bounded, abortable and scoped to the selected runtime.
- Never change channels, install on dialog open or restart on a timer.
- A newer channel target is a candidate, not a proven compatibility repair.
  Recheck the running handshake after installation before claiming completion.
- Unknown channel or handshake checks cannot produce a verified Done state.
- Keep native embeds and unsent drafts alive through dismiss/reconnect.

## Contract maintenance

A manually maintained base protocol is useful only with compatibility discipline:
retain supported older wire forms; update the window for breaking contracts and
test old/new client pairs. Optional capabilities use their own existing wire
negotiation (for example Chat messageVersion), not commit membership. This PR
does not introduce an unconsumed capability registry or claim all features are
covered by protocol 1. Release-manifest compatibility targeting and automated
schema-diff enforcement remain follow-up work; existing stable binaries need a
new Desktop release to receive this behavior.

## Validation and delivery

Regression tests cover independent source histories, explicit recovery direction,
legacy/invalid/offline behavior, recheck after updates, runtime switching, modal
dismissal, native embeds and drafts. Built Electron fixtures capture screenshots.
Human Review is required before landing the UI change. No production VPS updates
are part of this work. Update the private site documentation in a companion PR
under `content/docs/desktop.mdx` and `content/docs/settings-billing.mdx`.
