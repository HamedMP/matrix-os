# Matrix Messaging Bridge

Matrix OS 077 plans an owner-controlled Matrix messaging backbone for Telegram
and WhatsApp first. The production target is customer-VPS-native host services:
the selected Matrix homeserver, bridge runtimes, owner-local Postgres state,
gateway routes, and the first-party Messages app.

Implementation is blocked on the spike gates recorded in
`specs/077-matrix-messaging-bridge/spike-results.md`.

Key invariants:

- Beeper is prior art only, not the runtime backbone.
- Hermes starts with no room visibility.
- The bridged Matrix path is authoritative for Hermes and automations after a
  connected account has a bridge mapping.
- Messaging state stays in the owner-controlled VPS backup lifecycle.

## First Production Shape

- Homeserver: Synapse for the first Telegram/WhatsApp slice.
- Bridges: `mautrix-telegram` and `mautrix-whatsapp`.
- Runtime: VPS-native systemd units, not Docker Compose.
- Data root: `MATRIX_MESSAGING_ROOT`, defaulting to
  `/mnt/HC_Volume_104683898/matrix-messaging` on hosts with the extra Hetzner
  volume.

## Resource Floor

Messaging-enabled VPSes require at least 2 vCPU, 4 GiB RAM, and 40 GiB disk.
The Synapse-backed full bridge profile requires 2 vCPU, 6 GiB RAM, and 60 GiB
disk. Smaller hosts should leave messaging disabled or require an upgrade before
WhatsApp/Synapse enablement.

## Operations

- `matrix-messaging-health` reports coarse systemd state only.
- `matrix-messaging-backup` captures Synapse, Telegram bridge, WhatsApp bridge,
  and Matrix OS messaging tables including mappings and permissions.
- `matrix-messaging-restore <backup-dir>` restores Matrix OS messaging tables
  when `DATABASE_URL` is available and reports whether WhatsApp should be
  relinked.

RPO is 1 hour. RTO is 15 minutes after the VPS is reachable. WhatsApp may need a
fresh pairing if the restored backup is older than 24 hours or if the paired
device session is rejected.
