# Local Artifact Cleanup

Matrix OS production is moving toward Cloud Run for the centralized platform, but
local engineer machines, build hosts, and any legacy compose operators can still
fill disks with repeated host bundle builds and Docker cache. Use the local
cleanup tool for those hosts only.

This cleanup is deliberately narrow:

- Removes only old `dist/host-bundle` directories under explicitly approved
  repository or worktree roots.
- Optionally prunes Docker images and builder cache.
- Never prunes Docker volumes.
- Never touches `system-bundles/`, `$MATRIX_HOME`, owner data, backups, sync
  objects, or customer VPS runtime state.
- Defaults to dry-run mode.

## One-Off Cleanup

Preview actions first:

```bash
bun run cleanup:local-artifacts -- --root /home/deploy/matrix-os.worktrees --older-than-days 3 --docker
```

Apply after reviewing the output:

```bash
bun run cleanup:local-artifacts -- --root /home/deploy/matrix-os.worktrees --older-than-days 3 --docker --apply
```

The Docker cleanup plan runs:

```bash
docker image prune --all --force --filter until=168h
docker builder prune --all --force --keep-storage 20GB
```

It does not run `docker volume prune`, because volumes may contain databases or
other stateful development data.

## Suggested Timer

For engineer VPSes or a dedicated build host, run the cleanup daily with systemd:

```ini
[Unit]
Description=Matrix OS local artifact cleanup

[Service]
Type=oneshot
WorkingDirectory=/home/deploy/matrix-os
ExecStart=/usr/bin/env bun run cleanup:local-artifacts -- --root /home/deploy/matrix-os.worktrees --older-than-days 3 --docker --apply
```

```ini
[Unit]
Description=Run Matrix OS local artifact cleanup daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Keep this timer off customer runtime VPSes unless the host is also used as an
engineer/build machine. Customer VPS release updates should continue through the
host-bundle release flow and must not delete owner-controlled runtime data.

## Cloud Run Migration Note

This guardrail still fits the Cloud Run platform migration. Cloud Run removes the
single compose platform host from the production hot path, but it does not remove
local worktree builds, GitHub/self-hosted build artifacts, or legacy Docker cache
from machines that engineers use to develop and validate Matrix OS. Managed cloud
services should own platform runtime scaling; this script only keeps local
operator machines from failing before or during migration work.
