# Retired Symphony implementation

The original Symphony coding runner and app have been removed. A new implementation
will be designed separately. There is no supported Symphony API, app, or host
service in current bundles.

When an existing VPS installs the retirement bundle, the sync agent stops and
disables the old `matrix-symphony.service` after the new gateway and shell pass
their health checks. It removes the OS-owned systemd unit. Failures before the
new release metadata is committed use the normal rollback path, which restores
the previous service state. Once that metadata is committed, a later retirement,
Hermes reconciliation, or credential-cleanup error can leave the update marked
failed while the new bundle remains installed and Symphony stays stopped.
Recovery finalizes that committed bundle; restoring the older service then
requires an explicit rollback.

The sync agent retains an OS-owned unit and state backup at
`/etc/matrix-symphony-rollback` so a later update attempt cannot erase the
manual rollback path to an older bundle.

The update does not delete owner configuration, task history, or workspaces.
Existing `~/apps/symphony` files stay on disk but are hidden from the app
catalog and app router. `~/system/symphony`, `~/code/symphony-workspaces`, and
`/opt/matrix/env/symphony.env` remain for an owner-directed migration in the
future implementation. Do not infer that a stopped service or a hidden app
means those files have been deleted.

To verify a VPS after rollout, check the installed bundle version, gateway and
shell health, `systemctl is-active matrix-symphony.service`, and the absence of
new Symphony Linear polling requests. A successful bundle publish alone does
not prove that customer VPSes installed it.
