# Customer VPS support SSH access

New customer and recovery VPSes use a separate `matrix-support` login. The
platform must receive `MATRIX_SUPPORT_SSH_PUBLIC_KEY`, one ordinary Ed25519
public key, through protected deployment configuration. Production Cloud Run
binds `matrix-support-ssh-public-key:latest`; preview binds
`matrix-support-ssh-public-key-preview:latest`. Grant only the platform runtime
service account access to the matching secret. The private half stays in the
operator credential store and never enters Cloud Run, cloud-init, a VPS, or Git.
The Hetzner `HETZNER_SSH_KEY_NAME` root key is independent of this login.

Before enabling new provisioning, verify the selected secret version is active
and contains exactly one Ed25519 public key. A missing or invalid key makes the
platform reject provisioning before the Hetzner create call. The public key
appears in provider user data and in root-owned
`/etc/matrix/support/public-key`; no private key is delivered. Cloud-init then
runs `/usr/local/libexec/matrix-support-access install`. It fails bootstrap if
the helper is absent or its ownership, key, SSH, or sudo checks fail.

## Login and runtime access

On a fresh disposable VPS, offer only the dedicated support credential:

```sh
ssh -i <support-private-key> -o IdentitiesOnly=yes -o PreferredAuthentications=publickey matrix-support@<vps-ip>
id
sudo -iu matrix
```

The `matrix` account owns `/home/matrix/home` and the owner runtime. The
support account is separate from `matrix` and has no Docker group membership;
the helper deliberately grants it root sudo for host recovery. To inspect a
different local account, use `sudo -iu <user>` after checking that the account
exists with `getent passwd <user>`. Do not assume the account name from a
customer handle or copy credentials between users. Record support access under
the operator incident or ticket.

## Rotation

Install the new public half, as root, into
`/etc/matrix/support/candidate-public-key` with owner `root:root` and mode
`0644`. Run `sudo /usr/local/libexec/matrix-support-access stage-rotation`.
This leaves both public keys authorized. Open a **new** SSH session offering
only the candidate private credential, then compare its public key fingerprint
with `ssh-keygen -lf <candidate-public-key>`. After that successful login,
run `sudo /usr/local/libexec/matrix-support-access finalize-rotation
<verified-SHA256-fingerprint>`. Finalization removes the old key. Keep the old
private credential until candidate verification and finalization succeed.
Updating the platform secret alone affects new VPSes, not existing machines.

## Failure and recovery

For a new VPS that did not register, inspect `cloud-init status --long`,
`/var/log/cloud-init-output.log`, and the provisioning job. A missing platform
key is repaired in protected platform configuration before retry. If the helper
fails after the server is created, keep the VPS isolated; inspect the exact
failure, correct prerequisites or the root-owned source, and rerun the helper
as root before testing a fresh login. Do not relax account ownership or replace
the key with a root/customer key. Existing customer VPSes are never modified
by the new provisioning path.
