# Backup restore and startup readiness

The platform's provisioning page is shown before the Web Desktop starts. A VPS
being powered on is not proof that its restore gate, gateway, or web frontend is
ready. Never change a machine to `running` or create a restore-complete marker
just to dismiss the loading screen.

## Download completion contract

`distro/customer-vps/host-bin/matrix-r2-broker.mjs` must return success for `get`
only after it has streamed the response into an exclusive temporary file, synced
and closed the descriptor, and atomically renamed it to the destination. A failed
download must preserve an existing destination and clean its temporary file.

Do not wrap the owned `FileHandle` in an `autoClose: false` write stream: that
stream can retain a reference which prevents `FileHandle.close()` from resolving.
A pending promise alone does not keep Node running, so the process can exit zero
with only a hidden temporary file and no final destination. Awaiting bounded
response chunks directly keeps backpressure and leaves one descriptor owner.

## Snapshot account reconciliation

Cloud-init's declarative user configuration does not reliably reapply groups to
an existing snapshot user. Explicitly append the `docker` group to `matrix` before
the restore gate starts. This restores the already-declared host permissions for
access to the local Postgres container; it must not replace other groups or make
the Docker socket world-writable.

## Verification

- Run `tests/platform/r2-broker-download.test.ts`: these spawn the real CLI with
  mocked network responses and real files, covering initial/replacement/empty
  downloads, private file permissions, cleanup, and streaming failure.
- Run `tests/platform/snapshot-restore-groups.test.ts` and the existing
  `tests/platform/customer-vps-host-bundle.test.ts` contract suite.
- On a disposable snapshot-based VPS, verify restore success before checking
  gateway/frontend health and platform registration. Verify the exact requested
  bundle after deployment, not merely the base snapshot version.
- Keep owner data, backup objects, and the primary computer untouched during
  preview recovery. Do not publish customer identifiers or credentials in logs,
  documentation, or PR descriptions.

The platform's stale-provisioning/failure presentation is a separate concern;
this fix does not claim to add automatic reconciliation or error UI.
