# Unified Runtime Preview Verification

This top stack layer intentionally contains verification guidance rather than
preview-provisioning implementation. The shared `preview-vps.yml` workflow on
`main` owns provisioning, runtime-slot isolation, immutable bundle deployment,
and TTL cleanup. Reintroducing the older feature-local workflow would duplicate
and weaken that source of truth.

## Gate

Dispatch the shared preview workflow for the top pull request and record its
exact head SHA and installed bundle metadata. A successful workflow alone is
not deployment proof.

On the resulting `pr-<number>` runtime slot, verify through the Settings agent
surface and its foreground Terminal tabs:

1. Start with Hermes and OpenClaw reported as missing or stopped.
2. Choose **Install Hermes** and keep the foreground terminal visible until
   `/opt/matrix/bin/matrix-agent-runtime-control install hermes` succeeds.
3. Refresh Settings and confirm Hermes reports `installed` and healthy.
4. Choose **Install OpenClaw** and keep the foreground terminal visible until
   `/opt/matrix/bin/matrix-agent-runtime-control install openclaw` succeeds.
5. Refresh Settings and confirm OpenClaw reports `installed` and healthy.
6. Switch from Hermes to OpenClaw, then back to Hermes, and confirm messaging
   remains available after each transition.
7. Run `matrix-agent-runtime-control status`; its bounded response must report
   both runtimes installed with the expected service state.

Also verify `/opt/matrix/app/BUNDLE_VERSION`, `/opt/matrix/release.json`,
`matrix-gateway`, `matrix-shell`, and `matrix-sync-agent`. Do not record private
host identifiers, addresses, access tokens, or customer data in pull requests.

OpenClaw installation must continue to use the SHA-pinned host installer.
Hermes installation must continue to use the official Hermes installer through
the root-owned host-control path.
