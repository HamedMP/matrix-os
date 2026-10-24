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

## Acceptance checks

- Rendered production user data has one validated public key and an installer
  invocation; malformed and missing keys fail before server creation.
- On a fresh disposable VPS, authenticate as `matrix-support` offering only the
  dedicated private credential, then verify `sudo -iu matrix` and an additional
  local user where present.
- Exercise a missing-key provisioning failure and a repaired retry without
  touching a live customer VPS.

Stakeholder review: platform operations and support should review the access
and rotation procedure before production rollout.
