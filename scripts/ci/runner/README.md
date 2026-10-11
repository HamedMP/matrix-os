# Dedicated Linux CI benchmarks

This is an operator-admitted benchmark bridge, **not an open GitHub runner**.
Keep `MATRIX_CI_RUNNER_ENABLED` unset/false. GitHub's labels and ephemeral
registration do not bind a public-repository runner to a reviewed workflow or
commit. A malicious workflow can request the same label. Organization runner
groups can restrict workflow access; this personal repository does not have
that admission boundary. [GitHub runner access documentation](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

## Host setup and benchmark

Use a dedicated Ubuntu 24.04 x86-64 host with 8 vCPUs/32 GB RAM or 16 vCPUs/64 GB RAM. Keep the
Hetzner API key and operator GitHub credentials on the operator's computer.
Upload only this reviewed directory, never `.env`, SSH private keys, or a home
directory. Root manages Docker. The benchmark runs as UID 10001 in a fresh
container with no mounts, host credentials, Docker socket, capabilities, or
host networking. The image filesystem is read-only. Writable `/work` (16 GB on eight CPUs; 32 GB on sixteen),
`/tmp` (8 GB), and runner home (1 GB) are bounded tmpfs mounts charged against
the 28-GB/56-GB container memory limit, so repository code cannot fill host disk.
Package stores, Electron caches, and browsers stay under `/work`. The work
and temporary mounts explicitly allow execution for native modules and browser
binaries, while retaining `nosuid,nodev`. The firewall rejects new container access to the host and
private/metadata IPv4 ranges. The Docker network has IPv6 disabled.

Run on that host as root, from the uploaded directory:

```sh
bash bootstrap-host.sh
docker build --platform linux/amd64 --build-arg SOURCE_SHA=<reviewed-40-character-commit-sha> -t matrix-ci-benchmark:1 .
bash start-ephemeral.sh <reviewed-40-character-commit-sha> unit 8
```

Allowlisted suites: `unit`, `unit-shard-1` through `unit-shard-4`, `typecheck`,
`shell`, `checks`, `e2e`/`e2e-general`, `e2e-electron`, `full`, `qualification`. Workers must be
1–16. Checkout always fetches the exact SHA from
the fixed public repository and verifies HEAD. A fixed idle container process keeps tmpfs available while the host runs the
trusted image benchmark through `docker exec` and copies its reports. The
Docker exec exit status determines success, never a writable result marker
or a caller-supplied command. Every benchmark has
a 30-minute execution deadline; a timed-out container is killed immediately,
discarding its tmpfs evidence while retaining the bounded host log. It has an 8-CPU/28-GB or 16-CPU/56-GB cap, or 30 logical CPUs/112 GB on hosts with at least 32 logical CPUs and 120 million KiB RAM (64-GB work tmpfs). The larger cap reserves host CPU/RAM. There is no extra swap, and a 4096-process cap.
An exclusive lock admits one benchmark at a time, with a bounded 30-minute
wait if another benchmark is active. Service-container and root
fixture validation remains on GitHub-hosted runners.

The image pins Ubuntu by digest and Node 24.21.0, pnpm 10.33.4, and Bun 1.4.3
by version and SHA-256. OS libraries use Ubuntu's authenticated package indexes;
they are updated when rebuilding the image. Image preparation fetches the exact public commit's lockfile, uses frozen pnpm
fetch without lifecycle scripts or repository pnpm hooks, and installs every
locked Playwright Chromium version. Package age policy remains seven days. The
resulting store/browsers are immutable image content: no host cache or writable
store crosses PR runs. A matching lockfile copies package content into private
work tmpfs and uses readonly prepared browsers; another lockfile uses ordinary
frozen installation and browser downloads. The submitted source never executes
as image-builder root. The host records the resolved immutable image digest for
every admission before starting its container. Python bytecode is disabled so
unit tests cannot contaminate Desktop source-provenance checks; SSH client tools
and the existing test-supported Chromium channel are installed in the image.

PostgreSQL 16 runs as UID 10001 inside the same disposable container. It binds
only loopback, stores its cluster in work tmpfs, and grants its test-only role a
disposable `matrix_ci_platform_fixture_admin` database. The bounded native fixture
helper creates and cleans module-owned templates/clones. The general
`MATRIX_TEST_POSTGRES_URL` remains unset so hosted race/root check gates retain
their scope. PostgreSQL stops on completion or initialization failure; container
teardown and the execution deadline also terminate every remaining process.
Rebuild images periodically for security updates, recording the resulting image
ID with benchmark evidence.

`qualification` runs one complete pass and blocks on typecheck errors; it is the automatic Linux qualification scope. Other admitted benchmarks run cold then warm passes within the same disposable
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
and shell production build. Typecheck is blocking for `qualification`; cold/warm benchmarks retain the diagnostic baseline for historical comparisons. Pattern Scan stays hosted because it needs the trusted
PR base/main coverage frontier; database/root suites also stay hosted.
`full` and `qualification` run unit (4 workers on eight CPUs; 12 on sixteen; 16 on 32-thread/128-GB hosts), checks (2 workers), general browser E2E (2 workers), and the Electron build/regression lane (2 workers) concurrently
after one dependency/prerequisite build, awaiting every group. It is a full
**dedicated-host subset benchmark**, not proof that all required CI checks pass.

Host evidence is under `/var/lib/matrix-ci/results/run.*`: bounded recent logs,
`timing.tsv`, and unit cold/warm JSON reports. The host streams only fixed
artifact names, rejects links/directories, and writes regular files exclusively
with a 50-MB per-file bound and a 30-second transfer deadline. Missing required timing or unit profiles fail the benchmark. Treat
all test output as untrusted data. Do not execute or source copied files.
Retrieve evidence over the operator SSH connection. Remove old evidence after
comparison; the host cleanup timer removes results older than seven days.
It retains at most 20 completed result directories, skips symlinks, and removes
orphaned containers only after their 30-minute deadline plus 15-minute grace.

## Qualification coverage and migration gate

The automatic `qualification` scope is one complete pass, with blocking native
TypeScript checking and no repetition for benchmark timing. It preserves the
hosted test selection and all existing assertions/skips.

| Scope | Linux qualification | Required hosted coverage |
|---|---|---|
| Unit | Every root Vitest unit file; JSON report required | Existing integration/migration gates retain their separate environments |
| Mechanical checks | Native typecheck, sync build/tests/publish safety, real Agent SDK spike | Pattern Scan and React Doctor retain trusted hosted context |
| Web Desktop / Web Canvas | Production shell build; eleven docs/parity contract files | Docs-only classification and coverage-frontier planning remain hosted |
| Browser E2E | General browser suites excluding the same 34 build-gated native suites | Original environment-gated suites retain their skip semantics |
| Electron Desktop | Production build, terminal grid, twelve common regression files, standalone clipboard | macOS-only cases remain on their supported OS |
| PostgreSQL | Disposable loopback native fixtures for ordinary platform/gateway unit suites | Funded PostgreSQL race/migration and privileged root-fixture checks remain hosted |

Do not represent this subset as the entire required workflow. Keep **CI Results**
required and aggregate every hosted protected lane plus a verified completed
Linux qualification result for the same tested revision. Partial/manual
benchmarks never satisfy the Linux qualification check.

The controller attaches its result to the admitted PR head while executing
GitHub's exact synthetic merge commit. Before admission it verifies that this
commit has exactly two parents: the live PR head and base. It emits a bounded
provenance tuple containing tested merge SHA, head SHA, base SHA, PR number, and
controller SHA/ref, plus an immutable artifact whose name binds that tuple.

The hosted CI waiter has read-only permissions and validates the exact tested
merge SHA against authenticated GitHub workflow/run/job/artifact APIs. It accepts
only the default-branch `pull_request_target` controller, matching workflow ID,
repository and main-ref path, a successful completed dispatcher job, and the
same-run unexpired bounded provenance artifact. A similarly named check or a
copied run URL alone cannot pass. Missing, stale, partial, cancelled, failed, or
unverifiable evidence fails CI Results after a bounded wait.

Opt-in delegation applies only to admitted same-repository, non-draft main PRs
with source changes and `ready-for-ci`. Their hosted typecheck, production shell,
unit, SDK, parity/docs, and E2E jobs delegate to Linux qualification. Pattern Scan,
React Doctor, funded PostgreSQL/root contracts, and the sync package's Node 20
compatibility lane remain hosted. Forks, docs-only changes, other base branches,
main pushes, manual runs, and merge queues retain the hosted paths. Disabling
`MATRIX_CI_DEDICATED_ENABLED` restores hosted execution. Enable dispatch and
routing only after the default-branch controller, protected main-only secret
environment, host image digest, and passing qualification evidence are reviewed.

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
forwarding is accepted. Unit/full/qualification admission uses 8 workers on eight CPUs, 12 on sixteen, or 16 on 32-thread hosts with at least 120 million KiB RAM; full uses four unit workers on eight CPUs and reserves independent workers for checks and both E2E lanes. Other suites use 2. Pin the
host key in the controller's known-hosts file from the operator's independently
verified host fingerprint. Keep workflow environment restrictions and the
dedicated opt-in flag disabled until this setup and the workflow are reviewed.

The included `ci-dedicated.yml` controller creates **Dedicated CI Results** for
the admitted PR head for its verified synthetic merge commit and uploads the untrusted SSH log as an artifact.
Only complete single-pass qualification uses that check name; manually selected
partial/cold-warm benchmarks emit **Dedicated CI Benchmark**. For automatic PR dispatch it verifies the live PR is open, non-draft,
`ready-for-ci`, current-head, and from this repository. Forks remain hosted.
Create the `matrix-ci` GitHub environment with a deployment branch policy
allowing only `main`, and store `CI_RUNNER_SSH_KEY`, `CI_RUNNER_HOST`, and
`CI_RUNNER_KNOWN_HOSTS` there. After manual benchmarks pass and the controller
has merged, set repository variable `MATRIX_CI_DEDICATED_ENABLED=true`.
Keep **CI Results** required during this rollout; benchmark success alone is
not the merge gate. Disabling the variable stops new dedicated dispatches.

GitHub's default public-repository `pull_request_target` policy is currently
in evaluate mode, with enforcement announced for 2026-11-02. Check the
repository's Actions event-policy insights and configure an applicable policy
for these reviewed controllers before enforcement. Do not enable PR checkout
with privileged credentials. See
[GitHub's event-policy documentation](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
