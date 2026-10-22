# CI runner pool

The dedicated Linux host runs ephemeral GitHub Actions runners for `ci.yml`
([spec 633](../../../specs/633-ci-runner-pool/spec.md)). Each slot starts a
fresh container for one job, then removes it. CI routes to the pool only while
the host publishes a fresh `MATRIX_CI_POOL_HEARTBEAT`; otherwise jobs run on
GitHub-hosted runners.

## One-time setup

1. **GitHub App.** Create an app (or extend an existing one) with repository
   permissions **Administration: Read and write** (to mint just-in-time
   runners) and **Variables: Read and write** (for the heartbeat). Install it on
   `HamedMP/matrix-os` only. Note the App ID and installation ID, and download
   a private key.
2. **Host.** Ubuntu 24.04 x86-64 with Docker, `jq`, `openssl` and `curl`.
   Copy the key to `/etc/matrix-ci-pool/app.pem` (root only).
3. **Install.** From a checkout of `main` on the host:

   ```sh
   sudo bash scripts/ci/runner-pool/install.sh   # first run creates /etc/matrix-ci-pool/pool.env
   sudoedit /etc/matrix-ci-pool/pool.env         # APP_ID, INSTALLATION_ID, slot sizing
   sudo bash scripts/ci/runner-pool/install.sh   # builds the image and starts the slots
   ```

Rerun `install.sh` after changing the image or `pool.sh`; it restarts the slots.

## Operating

- Status: `systemctl status 'matrix-ci-pool-*'` and `docker ps --filter name=matrix-ci-slot-`.
- Logs: `journalctl -u 'matrix-ci-pool-slot@*' -f`.
- Drain: `sudo systemctl stop matrix-ci-pool-heartbeat 'matrix-ci-pool-slot@*'`.
  Runs that start more than 3 minutes later route to hosted runners. Jobs
  already queued for `matrix-ci` wait for a slot, so drain between runs.
- Sizing: `SLOTS * SLOT_CPUS` must not exceed the host's logical CPUs. Each
  slot is pinned to its own CPU range with a memory and process limit.

## Isolation

Containers get no Docker socket, host mounts or privileged mode, and receive
only a single-use JIT runner configuration. The App key and `pool.env` stay
root-only on the host. Fork PRs never route here, and fork workflows require
maintainer approval for every external contributor.
