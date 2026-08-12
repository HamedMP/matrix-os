# User-systemd terminal activation

Matrix OS host bundles built from the activation layer enable persistent
terminal ownership through static `matrix-zellij@<runtime-id>.service` user
units. The release remains controlled by the normal immutable host-bundle
channel and exact-version deployment paths; merging code does not promote a
stable channel or deploy a customer VPS.

## Activation source of truth

The installed app payload is authoritative:

```text
/opt/matrix/app/TERMINAL_USER_SYSTEMD_ENABLED
```

The gateway enables the user-systemd adapter only when this is a regular,
non-symlink file containing exactly `1\n`. The host-bundle build creates that
marker. Earlier bundles do not contain it and remain dormant.

The environment variable is an operator override:

- `MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1` forces activation for exact-head
  acceptance.
- `MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=0` disables activation for emergency
  diagnosis.
- Any other explicit value fails closed.

## Fail-closed installation readiness

Activation never falls back to the legacy gateway-owned terminal runtime. When
the marker or the exact `=1` override requests activation, gateway startup also
requires all of the following:

- the descriptor generation has a regular `GENERATION` marker whose value
  matches the app marker;
- the pinned generation contains regular, executable Zellij, keeper, and
  attach assets;
- `terminal-runtime/current` resolves to that exact generation;
- `matrix-zellij@.service` and `matrix-terminal.slice` are installed as regular
  static user-unit files; and
- the matrix user's systemd manager can discover both unit definitions.

Missing, malformed, symlink-substituted, or undiscoverable prerequisites abort
gateway startup with a generic terminal-runtime error. The host updater then
treats `/health` as failed and rolls back the app. It must not advertise a
healthy activation bundle while serving legacy terminals.

## Rollout

1. Build and register an immutable bundle without promoting a channel.
2. Deploy that exact version to a disposable or canary VPS.
3. Verify ordinary shell and coding-agent runtimes survive browser disconnect,
   gateway restart, and an in-place bundle update with unchanged runtime PIDs.
4. Verify deleting a runtime removes its user unit, cgroup, descendants,
   socket, descriptor, and launch snapshot.
5. Reboot the canary and confirm no terminal unit, command, or coding agent
   starts automatically.
6. Promote channels separately only after the canary evidence is accepted.

### New signups

Provision only from a golden image or clean-image bootstrap that installs the
complete bundle layout (`app`, `terminal-runtime`, and `user-systemd`) before
starting the gateway. A provision whose activated gateway fails the readiness
checks is failed, not silently downgraded. Refresh and verify the golden image
before making an activation release available to new customers.

### Existing users

VPSes whose installed updater predates the terminal-runtime bundle sections
must use a two-stage migration:

1. Deploy a dormant user-systemd bootstrap bundle, such as the bundle produced
   from PR #1129. Verify the VPS has the new updater while the activation marker
   remains absent.
2. Deploy the activation bundle. Verify the exact immutable generation, both
   user units, user-manager discovery, and a real `matrix-zellij@<runtime-id>`
   terminal before moving the rollout forward.

A direct old-updater-to-activation jump is intentionally rejected. The old
updater may retain the newer host helper after rolling the app back, allowing a
subsequent exact-version retry to repair a disposable canary, but that recovery
behavior is not the supported fleet migration plan.

This layer does not adopt an already-running legacy Zellij process into a user
unit. Exact-version rollout must therefore start with fresh/disposable hosts or
with a canary whose legacy terminal sessions have been deliberately drained.
Do not interpret an activation merge as authority for an automatic customer
fleet deployment.

## Rollback

Use the supported host updater rollback or deploy an earlier exact bundle. The
updater restores the previous `/opt/matrix/app`, which removes the activation
marker before the earlier gateway starts. Existing user terminal units are not
stopped by bundle update or rollback; they remain pinned to their immutable
runtime generations.

Reboot recovery is deliberately not provided. After reboot, descriptors are
interrupted metadata only: commands, coding agents, viewport, and scrollback do
not resume automatically.
