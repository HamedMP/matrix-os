# Dedicated Linux CI benchmarks

This is an operator-admitted benchmark bridge, **not an open GitHub runner**.
Keep `MATRIX_CI_RUNNER_ENABLED` unset/false. GitHub's labels and ephemeral
registration do not bind a public-repository runner to a reviewed workflow or
commit. A malicious workflow can request the same label. Organization runner
groups can restrict workflow access; this personal repository does not have
that admission boundary. [GitHub runner access documentation](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

## Host setup and benchmark

Use a dedicated Ubuntu 24.04 x86-64 host with 16 vCPUs and 64 GB RAM. Keep the
Hetzner API key and operator GitHub credentials on the operator's computer.
Upload only this reviewed directory, never `.env`, SSH private keys, or a home
directory. Root manages Docker. The benchmark runs as UID 10001 in a fresh
container with no mounts, host credentials, Docker socket, capabilities, or
host networking. The firewall rejects new container access to the host and
private/metadata IPv4 ranges. The Docker network has IPv6 disabled.

Run on that host as root, from the uploaded directory:

```sh
bash bootstrap-host.sh
docker build --platform linux/amd64 -t matrix-ci-benchmark:1 .
bash start-ephemeral.sh <reviewed-40-character-commit-sha> unit 8
```

Allowlisted suites: `unit`, `unit-shard-1` through `unit-shard-4`, `typecheck`,
`shell`, `checks`, `e2e`/`e2e-general`, `e2e-electron`, `full`. Workers must be
1–16. Checkout always fetches the exact SHA from
the fixed public repository and verifies HEAD. The host script executes the
trusted image entrypoint, never a caller-supplied command. Every benchmark has
a 30-minute deadline, 16-CPU/56-GB cap, no extra swap, and a 4096-process cap.
An exclusive lock admits one benchmark at a time, with a bounded 30-minute
wait if another benchmark is active. Service-container and root
fixture validation remains on GitHub-hosted runners.

The image pins Ubuntu by digest and Node 24.21.0, pnpm 10.33.4, and Bun 1.4.3
by version and SHA-256. OS libraries use Ubuntu's authenticated package indexes;
they are updated when rebuilding the image. Chromium is installed from the
reviewed lockfile's Playwright version without root-only dependency installation.
Rebuild images periodically for security updates, recording the resulting image
ID with benchmark evidence.

Each admitted benchmark runs cold then warm passes within the same disposable
container, sharing its dependencies/build state. Both passes run all tests for
the selected suite. It is destroyed after this benchmark, even after failure.
Cold includes checkout/install/prerequisite timings separately; warm is a
second execution with the same source and already-built prerequisites. A failing
suite still receives its warm pass and the final command exits unsuccessfully.
These
are execution timings, not GitHub queue or full required-check elapsed times.
`e2e-general` runs the base E2E configuration. `e2e-electron` builds Electron
then runs the environment-gated regressions explicitly listed in `ci.yml`.
`checks` covers sync client, Agent SDK compatibility, docs/parity contracts,
and shell production build. Typecheck is diagnostic, matching existing CI's
nonblocking baseline. Pattern Scan stays hosted because it needs the trusted
PR base/main coverage frontier; database/root suites also stay hosted.
`full` runs unit (12 workers), checks (2 workers), and E2E (2 workers) concurrently
after one dependency/prerequisite build, awaiting every group. It is a full
**dedicated-host subset benchmark**, not proof that all required CI checks pass.

Host evidence is under `/var/lib/matrix-ci/results/run.*`: bounded recent logs,
`timing.tsv`, and unit cold/warm JSON reports. The host copies only fixed
artifact paths, without following symlinks, with a 50-MB per-file bound. Treat
all test output as untrusted data. Do not execute or source copied files.
Retrieve evidence over the operator SSH connection. Remove old evidence after
comparison; the host cleanup timer removes results older than seven days.
It retains at most 20 completed result directories, skips symlinks, and removes
orphaned containers only after their 30-minute deadline plus 15-minute grace.

## Admission and future automatic CI

A disposable nonroot container reduces blast radius but shares the host kernel.
Keep this dedicated host patched and empty of sensitive data. The first rollout
is exact-SHA manual benchmarking with no registration token or listener at all.
Thus no registration/PAT/cloud secret can enter test code.

Automatic dispatch must come from an immutable, reviewed default-branch
workflow through a dedicated forced-command SSH key. The key may invoke only a
root-owned dispatcher with bounded SHA/suite/workers, no PTY, forwarding, shell,
or file transfer. The SSH key stays outside the benchmark container. The
trusted workflow must use read-only source permissions, with check-write access
only on its controller to report the admitted SHA, and never execute PR
code before dispatch. Do not use `pull_request_target` to check out PR code
alongside credentials. The dedicated host must not accept generic GitHub
runner registration until enforceable workflow admission is available.

Install the bridge on the host with only a dedicated public key on stdin:

```sh
bash install-dispatch.sh < dedicated-ci-ed25519.pub
```

From the trusted controller, dispatch exactly `run <40-character-sha> <suite>`
to SSH user `matrixci`. No other command, shell, SCP, PTY, agent, TCP, or tunnel
forwarding is accepted. Unit/full use 12 workers; other suites use 2. Pin the
host key in the controller's known-hosts file from the operator's independently
verified host fingerprint. Keep workflow environment restrictions and the
dedicated opt-in flag disabled until this setup and the workflow are reviewed.

The included `ci-dedicated.yml` controller creates **Dedicated CI Results** for
the exact admitted commit and uploads the untrusted SSH log as an artifact.
For automatic PR dispatch it verifies the live PR is open, non-draft,
`ready-for-ci`, current-head, and from this repository. Forks remain hosted.
Create the `matrix-ci` GitHub environment with a deployment branch policy
allowing only `main`, and store `CI_RUNNER_SSH_KEY`, `CI_RUNNER_HOST`, and
`CI_RUNNER_KNOWN_HOSTS` there. After manual benchmarks pass and the controller
has merged, set repository variable `MATRIX_CI_DEDICATED_ENABLED=true`.
Keep **CI Results** required during this rollout; benchmark success alone is
not the merge gate. Disabling the variable stops new dedicated dispatches.
