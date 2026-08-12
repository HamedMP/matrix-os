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
