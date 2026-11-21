# S3: build a Vite app in the container sandbox with registry-only egress

**Verdict: partial pass.** A template app and a heavier Tailwind v4 app install and build
inside the real container sandbox. Every workload network path except the proxy socket
fails in the kernel, and the proxy allowed only the npm registry. It is partial because
the current container profile does not run the build as shipped (five gaps below), and
two parts of the pass condition were not exercised.

Code and raw data: branch `spike/2691-s3` at `a4b303bfe`, directory `spikes/2691-s3/`
(cut from `feat/2691-container-launcher` at `6ebe690d5`).

Environment: Linux 6.8 x86_64, 32 CPUs, 124 GiB, bubblewrap 0.9.0, Node 24.22.0,
pnpm 10.33.4. The host was shared with CI; load average was 18 to 49 during every run.

## What ran

The spike called the production sandbox functions directly: `probeContainerSandbox`
(chose `hardened: true`, rlimits nproc 256, nofile 4096, fsize 1 GiB, as 4 GiB, no
cgroup), `validateSandboxMountSources`, `buildContainerSandboxCommand`, and
`writeSeccompProgram`. Spike-only substitutions: a Node directory with pnpm added, the
proxy socket carried in the broker socket slot, and extra environment passed through the
launcher's `env -i`. No launcher code changed.

Not exercised:

- The agent loop. Commands used fixed argv; Pi did not issue them through a tool.
- The bridged app viewer (`srcdoc`, origin null). Apps rendered in headless Chromium
  over HTTP only, so "loads through the bridged viewer" is not proven.
- A real Lambda MicroVM guest, mirror caching, and concurrent owners.

## What breaks as shipped (measured)

| Gap | Cause | Fix |
| --- | --- | --- |
| `pnpm install` aborts under the 4 GiB `RLIMIT_AS` | pnpm starts one worker per CPU; each reserves address space | `PNPM_MAX_WORKERS=2` |
| Tailwind v4 `vite build` aborts under 4 GiB | `RLIMIT_AS` and glibc arenas; passes at 16 GiB | `MALLOC_ARENA_MAX=2` |
| `pnpm build` fails | No `/bin/sh` in the view | Run `node node_modules/vite/bin/vite.js build` with fixed argv |
| A medium resolve fills the 256 MiB `/workspace` tmpfs; pnpm hangs with no error | Store and metadata cache in tmpfs | Persistent store bind plus timeout and free-space check |
| No slot for the egress socket | Launcher has none | Dedicated bind, for example `/run/matrix-egress/registry.sock` |

Also: `home/apps/_template-vite` ships no lockfile, so its `--frozen-lockfile` install
fails. Dependency lifecycle scripts are skipped by pnpm 10 by default, and esbuild,
rollup, and Tailwind's native packages still work.

## Egress (measured)

Two proxy modes were prototyped. Both pass 12 of 12 in-sandbox probes. Direct TCP,
DNS, the metadata endpoint, loopback, other hosts, publish, and path traversal are all
refused.

- **Mirror** (pull-through registry): GET and HEAD of metadata and tarballs only;
  upstream fetch with `redirect: "error"`, 30 s timeout, no client headers; rewrites
  tarball URLs. pnpm still checks integrity against metadata.
- **CONNECT**: allows only `registry.npmjs.org:443` after a public-address check.

Recommended: mirror mode, operated by the platform. It sees package names, so it can
enforce `minimumReleaseAge`, a denylist, and per-owner byte caps, and it can cache.
The probes found a bug worth a production test: a Node `BlockList` rule for
`::ffff:0:0/96` matches every plain IPv4 address.

## Key measured numbers

Three runs each, mirror mode, 32-CPU host. Memory is a cgroup `memory.peak` upper bound.

| App | Scenario | Wall time (ms) | Memory peak |
| --- | --- | --- | --- |
| Template (68 packages) | cold frozen install | 867-1,107 | 416-431 MB |
| Template | warm store | 610-734 | 199-202 MB |
| Template | `vite build` | 939-1,178 | 285-316 MB |
| Heavy (Tailwind v4 and others) | cold frozen install | 3,270-3,552 | 855-913 MB |
| Heavy | `vite build` with `MALLOC_ARENA_MAX=2` | 5,503-6,735 | 644-726 MB |
| Heavy | cold resolve, no lockfile (1 run) | 5,135 | 1,238 MB |

Disk: template store 73 MB, heavy store 220 MB plus a 106 MB metadata cache. A store on a
different mount from the worktree doubles disk use (copies, not hardlinks). About 0.5 GB
covers the heavy app.

## Inferred, not measured

- A 2 vCPU guest may pass without the worker cap, because the failure grows with CPU
  count. Not tested.
- Without cgroup delegation (Lambda MicroVMs, Cloud Run) nothing enforces build memory
  per workload; only rlimits apply.

## What changes

- A separate build workload launched by a gateway-side build tool with fixed argv, in
  the same sandbox. The chat worker gets no shell.
- Dedicated egress socket; the gateway forwards it to the platform mirror and adds the
  per-runtime token, so the workload never holds it.
- Fixed build environment: registry URL, `PNPM_MAX_WORKERS=2`, `MALLOC_ARENA_MAX=2`,
  `CI=1`, `npm_config_ignore_scripts=true`, `npm_config_update_notifier=false`.
- pnpm pinned in the runtime node directory (`/opt/matrix/runtime/node`), ignoring the
  app's `packageManager` field.
- No package scripts.
- Per-owner pnpm store on its own bind at `/workspace/.pnpm-store`, outside the flushed
  home, under a disk quota.
- Wall-clock timeout and free-space check on every install and build; failure reports
  `needs_build` with a safe error.
- Keep `RLIMIT_AS` at 4 GiB only together with the caps above.
- Ship a lockfile with `_template-vite`, or resolve once and use frozen installs after.

## Open questions

- A second writable bind for the store in the container profile, or a quota'd cache
  inside the home excluded from flush?
- Gateway-forwarded egress socket or a direct platform endpoint: who holds the proxy
  token?
- Should default apps (root toolchain) ever be rebuilt in the container? Their
  dependencies are not in the view.
