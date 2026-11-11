# Support SSH provisioning

## Goal

Every new customer VPS, including a recovery replacement, installs the separate
`matrix-support` SSH account from an explicit operator Ed25519 public key.

## Runtime path

The platform reads `MATRIX_SUPPORT_SSH_PUBLIC_KEY` from protected configuration.
`buildHostConfig` validates its single-key SSH wire format before Hetzner server
creation. The rendered cloud-init writes the public key as root-owned
`/etc/matrix/support/public-key`, protects its parent directory, then runs the
root-owned `matrix-support-access install` helper. Missing or invalid keys fail
provisioning before the provider create call. Helper failures stop bootstrap.

## Boundaries and failure

Only the public half enters user data and the VPS. The support account has its
own home and authorized key; its existing helper grants explicit sudo for
recovery. No customer owner SSH credential is copied. Existing VPSes are not
mutated. A failed boot remains failed until the key or host prerequisite is
fixed and provisioning is retried. Key rotation uses the helper's staged
two-key flow and a verified new SSH session before finalization.

## Error policy

- Platform: a missing or invalid key throws in `buildHostConfig` before any
  provider call. The provisioning or recovery job logs the error server-side
  and marks the machine and job failed in one transaction with a generic
  failure code. Clients never see the key, the validation detail or the
  config variable name.
- VPS: the helper exits non-zero with a short message and `set -eu` stops
  bootstrap. Messages stay in the VPS cloud-init log and never contain key
  material.

## Concurrency and crash safety

- Rendering is pure for each job; durable job leases already serialize
  provisioning for a machine.
- `install` runs once from the serial cloud-init `runcmd`. Rotation is a
  manual, single-operator procedure; concurrent rotations are unsupported and
  no lock is added.
- Every write goes to a `mktemp` file in the destination directory and is
  then renamed with `mv -T`, so a crash leaves either the old file or the new
  one. Sudoers content is checked with `visudo -c` before the rename.
  Rerunning `install` with the same key is idempotent; a different existing
  key is refused until rotated. An interrupted `finalize-rotation` resumes.

## Resource limits and cleanup

- The key is one Ed25519 line of at most 1023 bytes with a fixed 51-byte
  decoded blob. Cloud-init user data stays within the existing byte budget,
  which tests enforce.
- Temp files are removed on failure and by an `EXIT` trap. A hard kill can
  leave at most one root-owned temp file per interrupted run. No recurring
  sweep is added because nothing creates temp files repeatedly.
- Not applicable: no new endpoints, WebSockets, IPC, in-memory caches or
  outbound network calls.

## Acceptance checks

- Rendered production user data has one validated public key and an installer
  invocation; malformed and missing keys fail before server creation.
- On a fresh disposable VPS, authenticate as `matrix-support` offering only the
  dedicated private credential, then verify `sudo -iu matrix` and an additional
  local user where present.
- Exercise a missing-key provisioning failure and a repaired retry without
  touching a live customer VPS.

## Public documentation deliverable

A separate PR in `FinnaAI/matrix-os-site` under `content/docs/` explains, for
customers, that new Matrix computers include a dedicated `matrix-support`
login for recovery, that it is separate from the owner's own credentials, and
that existing computers are unchanged. It stays
public-safe: no key material, hostnames, account handles, or operator
commands. Done when that PR is linked from the ENG-389 ticket and this PR.

Stakeholder review: platform operations and support should review the access
and rotation procedure before production rollout.
