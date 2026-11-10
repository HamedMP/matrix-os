# CI runner pool

The dedicated Linux host runs ephemeral GitHub Actions runners for `ci.yml`
([spec 633](../../../specs/633-ci-runner-pool/spec.md)). Each slot starts a
fresh container for one job, then removes it. CI routes to the pool only while
the host publishes a fresh `MATRIX_CI_POOL_HEARTBEAT`; otherwise jobs run on
GitHub-hosted runners.

## One-time setup

1. **GitHub App.** Create a dedicated app for the pool (for example
   `matrix-ci-runner-pool`) under the repository owner's developer settings.
   Do not reuse the CI gate app: its key is passed into CI jobs and it must
   not hold repository administration. Disable the webhook, grant only the
   repository permissions **Administration: Read and write** (to mint
   just-in-time runners) and **Variables: Read and write** (for the
   heartbeat), and install it on `HamedMP/matrix-os` only. Note the App ID
   and the installation ID (the number at the end of the installation's
   settings URL), and generate one private key.
2. **Host.** Ubuntu 24.04 x86-64 with Docker, `jq`, `openssl`, `curl` and `iptables`.
   Copy the key to `/etc/matrix-ci-pool/app.pem` (root only).
3. **Install.** From a checkout of `main` on the host:

   ```sh
   sudo bash scripts/ci/runner-pool/install.sh   # first run creates /etc/matrix-ci-pool/pool.env
   sudoedit /etc/matrix-ci-pool/pool.env         # set APP_ID and INSTALLATION_ID; check slot sizing
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
only a single-use JIT runner configuration. Each job's work directory
is a fresh anonymous volume on the host's ext4 disk and its `/tmp` is a tmpfs;
both are deleted with the container. `/tmp` must be a tmpfs: tests of the
collaboration file-identity code write there, and that code accepts ext4 only
from a process with no seccomp filter, which a container always has. They run on the `matrix-ci-pool`
network, whose firewall (`firewall.sh`, `matrix-ci-pool-firewall.service`)
rejects new connections to the host and to private, link-local and multicast
addresses; slots refuse to start without it. The App key and `pool.env` stay
root-only on the host, and the pool requests an installation token limited to
this repository's Administration and Variables permissions.

Fork source never runs here. `ci.yml` routes forks to hosted runners, but a
fork PR can edit `ci.yml`, so the image enforces it: `job-started.sh` runs
before every job and, for anything that is not a push, a merge-queue run or
a same-repository PR, kills the runner before a step can start. Failing the
hook alone is not enough: `if: always()` steps still run after a failed hook. Slots share no traffic (`enable_icc=false`, no
`NET_RAW`) and have IPv6 disabled.
