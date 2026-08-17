# Contract: Customer VPS Host

This contract describes what cloud-init installs and what the control plane can assume after `/vps/register`.

## Cloud-Init Inputs

The platform renders `distro/customer-vps/cloud-init.yaml` with these values:

```typescript
{
  machineId: string;
  clerkUserId: string;
  handle: string;
  imageVersion: string;
  platformRegisterUrl: string;
  registrationToken: string;
  r2Bucket: string;
  r2Prefix: `matrixos-sync/${string}/`;
  postgresPassword: string;
}
```

The rendered file must not log `registrationToken`, R2 secrets, or `postgresPassword`.

## Host Layout

```text
/opt/matrix/
├── bin/
│   ├── matrixctl
│   ├── matrix-db-backup.sh
│   └── matrix-restore.sh
├── env/
│   ├── host.env
│   ├── postgres.env
│   └── r2.env
├── postgres-compose.yml
└── restore-complete

/home/matrix/
├── home/
└── projects/

/var/lib/matrix/
├── db/snapshots/
└── logs/
```

Secrets under `/opt/matrix/env/` must be owned by `root:matrix` and mode `0640` or stricter.

## Systemd Units

| Unit | Type | Required Ordering |
|------|------|-------------------|
| `matrix-restore.service` | oneshot | Runs before gateway/shell; preserves or atomically writes the durable restore-complete flag. |
| `matrix-gateway.service` | service | Requires restore-complete flag and Postgres container. |
| `matrix-shell.service` | service | Starts after gateway dependencies. |
| `matrix-sync-agent.service` | service | Starts on boot; handles files and heartbeat. |
| `matrix-db-backup.service` | oneshot | Runs backup script. |
| `matrix-db-backup.timer` | timer | Hourly. |

Gateway must not serve traffic until restore/fresh decision completes.

## Registration Callback

After boot and restore/fresh completion, the host calls:

```http
POST /vps/register
Authorization: Bearer <registrationToken>
Content-Type: application/json
```

```json
{
  "machineId": "uuid",
  "hetznerServerId": 123456,
  "publicIPv4": "1.2.3.4",
  "publicIPv6": "2a01:4f8:...",
  "imageVersion": "matrix-os-host-2026.04.26-1"
}
```

The callback must retry with bounded exponential backoff for transient network failures and stop after registration succeeds or token expiry is reached.

## Restore-Or-Fresh Contract

Before gateway start:

1. Treat a regular `/opt/matrix/restore-complete` file as durable proof that this installed host already completed its restore-or-fresh decision. Preserve it and use the machine-local Postgres volume without contacting R2.
2. Reject symlinked or non-regular completion markers and keep the gateway stopped.
3. When the marker is absent on a sanitized clean or replacement image, fetch `system/vps-meta.json` and `system/db/latest`.
4. If neither object exists, or registration exists before the first backup, initialize from the machine-local state and atomically write the completion marker.
5. If a latest snapshot exists, download it, restore Postgres, and atomically write the completion marker only after `pg_restore` succeeds.
6. If the first-boot/replacement restore fails, do not start the gateway. Log locally and expose failure through status/heartbeat when possible.

Golden-image sanitization must remove the completion marker. Ordinary service restarts, host reboots, and bundle updates must not remove it or replace newer local state with an older remote snapshot.

## Backup Contract

Hourly backup runs:

```text
pg_dump --format=custom --file=/var/lib/matrix/db/snapshots/<ts>.dump matrix
matrixctl r2 put /var/lib/matrix/db/snapshots/<ts>.dump system/db/snapshots/<ts>.dump
matrixctl r2 put-latest system/db/snapshots/<ts>.dump
```

Requirements:

- `latest` is updated only after snapshot upload succeeds.
- Backup process has a timeout and exits non-zero on failed dump/upload.
- Retention pruning is deferred in this slice; the backup script must not call a no-op prune path.
- Prune never deletes the object referenced by `latest`.
- Logs do not include R2 credentials or raw provider response bodies.

## Firewall Contract

Hetzner firewall configuration:

- Inbound 22 only from ops IP ranges.
- Inbound 443 from Cloudflare/control-plane allowed sources.
- No inbound Postgres.
- Outbound HTTPS allowed for R2, platform registration, package install, and host bundle download.
