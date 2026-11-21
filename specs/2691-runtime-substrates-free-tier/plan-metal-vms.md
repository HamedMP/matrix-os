# Free tier on Matrix bare-metal VMs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a free signup on the staging platform gets a full Matrix computer as a Cloud Hypervisor VM on a Matrix-operated host, which sleeps when idle and wakes for every entry point (web, WebSocket, Native Mobile, CLI, scheduled jobs).

**Architecture:** a new `packages/hostd` service on each bare-metal host owns VM lifecycle, memory, ingress, and a vsock guest agent. The platform gains a `metal` substrate on top of PR #3411's substrate model, with wake-on-request routing, metal provisioning and registration, the free plan, and an idle sleeper. The gateway exposes a lifecycle endpoint (busy state and next scheduled time) and catches up missed cron runs.

**Tech Stack:** TypeScript 5.9 strict ES modules, Node 24, Hono, Zod 4 (`zod/v4`), undici 7.30.1 (unix-socket and vsock transport), Kysely/Postgres, Vitest; Cloud Hypervisor v54.1; Ubuntu 24.04 hosts and guests; bash for host provisioning.

**Spec:** `specs/2691-runtime-substrates-free-tier/design-metal-vms.md` (approved), evidence `spikes/s7-bare-metal-vms.md`. Linear: ENG-520 (stacks share it).

## Global Constraints

- Every change ships from a manual `git worktree add -b <branch> ../<dir> origin/main`; dependent PRs use `gh stack`; each layer names ENG-520 and its stack.
- TDD for every task: failing test first, shown red, then green. Tests live under `tests/<package>/`.
- Every external `fetch`/undici request has `AbortSignal.timeout(ms)`: 10 s APIs; hostd `resume` 8 s; hostd `create` 120 s.
- Every mutating route (including DELETE) has Hono `bodyLimit` (hostd: 64 KiB; platform internal: 4 KiB) and Zod validation of path, query, and body.
- Errors to clients are typed codes; never provider names, paths, IPs, or raw errors.
- Every in-memory Map/Set has a cap and eviction.
- No new embedded databases. hostd stores per-VM state as JSON files written atomically (`{ flag: 'wx' }` temp + rename).
- Free VM limits: boot 2048 MiB, hotplug ceiling 8192 MiB, 2 vCPU, 20 GiB disk, egress shaped to 50 Mbit/s, port 25 blocked.
- Sleep: free VMs only, after 60 minutes with no owner interaction and nothing running; never while an agent turn, routine, or job runs; a free VM awake 6 hours with no owner interaction is suspended and flagged. Paid VMs never sleep or shrink.
- Scheduled wake fires 60 s before the next scheduled time.
- Snapshots live in the data pool (`/var/lib/matrix-hostd/snapshots`, a filesystem on its own thin LV), never the root filesystem; a failed snapshot leaves the VM running.
- Guest settings proven in S7: kernel args `memhp_default_state=online memory_hotplug.online_policy=auto-movable page_reporting.page_reporting_order=5`; `ptp_kvm` plus `phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -O 0 -R 4 -S 0.5`; restore with `memory_restore_mode=ondemand`.
- Max 3000 additions or 50 files per PR; about 5 to 6 layers per stack.

## Review Focus

1. **Wake while a wake is in flight.** Two owner tabs and the mobile app hit a sleeping VM at once. Expected: one resume, all requests served. Test in Task P3 (`concurrent owner requests share one resume`).
2. **Sleep racing a new request.** A request arrives while the sleeper is snapshotting. Expected: the request waits and the VM resumes after the snapshot; no lost request, no double resume. Test in Task H2 (`resume during suspend waits for the snapshot and then resumes`).
3. **Snapshot fails** (full pool, Cloud Hypervisor error). Expected: the VM keeps running, the platform keeps it `running`, and an alert is logged. Tests in Task H2 (`snapshot failure keeps the VM running`) and Task P6 (`sleeper leaves running on suspend failure`).
4. **Scheduled job due while asleep.** Expected: the VM is awake 60 s before and the job runs on time; if missed, it runs once on wake. Tests in Task G1, Task G2 and Task P6 (`wakes 60 s before nextScheduledAt`).
5. **Host agent unreachable.** Expected: owner requests get a 503 `runtime_unavailable` with `Retry-After`, the sleeper does not mark the VM asleep, and no state is lost. Test in Task P2 (`hostd timeout maps to failed provider_unavailable`).

---

## Stack H: host agent (`packages/hostd`, branch prefix `feat/eng-520-hostd`)

### Task H1: Cloud Hypervisor client

**Files:**
- Create: `packages/hostd/package.json`, `packages/hostd/tsconfig.json`, `packages/hostd/src/ch-client.ts`
- Test: `tests/hostd/ch-client.test.ts`

**Interfaces:**
- Produces: `createChClient(socketPath: string): ChClient` with `info(signal): Promise<ChVmInfo>`, `pause`, `resume`, `snapshot(destinationDir: string, signal)`, `resizeMemory(totalBytes: number, signal)`, `powerButton`, `shutdownVmm` (all `(signal: AbortSignal) => Promise<void>` unless noted). `ChVmInfo = { state: 'Created' | 'Running' | 'Paused' | 'Shutdown'; memoryActualBytes: number }`. Throws `ChError` with `code: 'unreachable' | 'rejected' | 'timeout'`.

- [ ] **Step 1: Write the failing tests** against a fake Cloud Hypervisor HTTP server listening on a temp unix socket:
  - `info parses state and memory_actual_size`
  - `snapshot sends PUT /api/v1/vm.snapshot with destination_url file://<dir>`
  - `resizeMemory sends PUT /api/v1/vm.resize with desired_ram`
  - `a 500 response throws ChError rejected without the server body in the message`
  - `an aborted signal throws ChError timeout`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/hostd/ch-client.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** with undici `Agent({ connect: { socketPath } })` and `request`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hostd): add the Cloud Hypervisor API client`.

### Task H2: VM records and lifecycle

**Files:**
- Create: `packages/hostd/src/vm-store.ts`, `packages/hostd/src/vm-lifecycle.ts`, `packages/hostd/src/exec.ts`, `distro/metal-host/systemd/matrix-vm@.service`, `distro/metal-host/systemd/matrix-vm-restore@.service`
- Test: `tests/hostd/vm-store.test.ts`, `tests/hostd/vm-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ChClient` (H1).
- Produces:
  - `VmRecord = { id: string; machineId: string; generation: number; handle: string; tier: 'free' | 'paid'; state: 'creating' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'stopped' | 'failed'; privateIPv4: string; mac: string; bootMiB: number; maxMiB: number; diskGiB: number; chVersion: string; snapshot: { dir: string; takenAt: string; chVersion: string } | null; updatedAt: string }`.
  - `createVmStore(dir: string)` with `get(id)`, `list()`, `put(record)` (atomic), `remove(id)`.
  - `createVmLifecycle(deps: { store; exec: Exec; ch: (id: string) => ChClient; pool: { freeBytes(): Promise<number> }; gatewayHealth: (ip: string, signal: AbortSignal) => Promise<boolean>; clock })` with `create(spec: CreateVmSpec)`, `start(id)`, `suspend(id)`, `resume(id, budgetMs: number): Promise<'running' | 'starting'>`, `stop(id)`, `destroy(id)`. One in-flight operation per VM id (a capped Map of promises); later callers join it.
  - `id` is `vm_` plus 24 hex characters; the machine id is never used in a path.

- [ ] **Step 1: Write the failing tests** with a fake `exec` and a fake `ch`:
  - `create writes the record, clones the golden LV, writes the seed, and starts matrix-vm@<id>`
  - `suspend trims through the guest agent, waits 5 s, snapshots into the pool, then stops the unit`
  - `snapshot failure keeps the VM running and the record running`
  - `suspend refuses with pool_full when freeBytes is below 2 x bootMiB and keeps the VM running`
  - `resume restores with memory_restore_mode=ondemand and returns running once the gateway is healthy`
  - `resume returns starting when the gateway is not healthy within budgetMs`
  - `resume during suspend waits for the snapshot and then resumes` (one snapshot, one restore)
  - `concurrent resume calls share one restore`
  - `destroy removes unit, LV, seed, snapshot and record and is idempotent`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/hostd/vm-lifecycle.test.ts tests/hostd/vm-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The systemd units run `cloud-hypervisor` as user `matrix-vm` with the S7 flags (`--memory size=<boot>M,hotplug_method=virtio-mem,hotplug_size=<max-boot>M`, `--balloon size=0,free_page_reporting=on,deflate_on_oom=on`, `--disk ...,image_type=raw`, `--vsock cid=<3+n>,socket=...`, serial to a file under `/var/log/matrix-vm/`), reading `/var/lib/matrix-hostd/vms/<id>/unit.env`. After suspend, the snapshot file is made sparse with `fallocate --dig-holes`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hostd): add VM records and the suspend/resume lifecycle`.

### Task H3: guest agent and memory controller

**Files:**
- Create: `packages/hostd/src/guest-agent/agent.ts` (runs inside the guest), `packages/hostd/src/guest-client.ts`, `packages/hostd/src/memory-controller.ts`
- Test: `tests/hostd/guest-agent.test.ts`, `tests/hostd/memory-controller.test.ts`

**Interfaces:**
- Produces:
  - Guest agent on vsock port 1024, newline-delimited JSON. Requests: `{"op":"stats"}` returns `{ psiSome10: number; availableMiB: number; anonMiB: number }`; `{"op":"trim"}` (drop caches, compact) returns `{ ok: true }`. Any other input gets `{ error: "bad_request" }`. The agent reads at most 4 KiB per line and closes idle connections after 10 s.
  - `createGuestClient(vsockPath: string)` with `stats(signal)` and `trim(signal)`.
  - `decideMemory(sample: { psiSome10: number; availableMiB: number; actualMiB: number; idleSeconds: number }, policy: { bootMiB: number; maxMiB: number; tier: 'free' | 'paid'; hostAvailableMiB: number }): { action: 'grow' | 'shrink' | 'none'; targetMiB: number }`.

- [ ] **Step 1: Write the failing tests:**
  - `grows by 1024 MiB when psiSome10 > 10 and available < 15% of actual, capped at maxMiB`
  - `never grows when hostAvailableMiB < 32768`
  - `shrinks toward bootMiB in 1024 MiB steps when idleSeconds >= 600 and available > 50% of actual`
  - `paid tier never shrinks`
  - `guest agent answers stats from /proc/pressure/memory and /proc/meminfo fixtures`
  - `guest agent rejects a line longer than 4 KiB`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/hostd/memory-controller.test.ts tests/hostd/guest-agent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure policy; the loop in `memory-controller.ts` samples every 5 s per running VM and calls `ch.resizeMemory`. The guest agent is built to one file and installed as `matrix-guest-agent.service` in the golden disk (Task H6).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hostd): add the guest agent and memory controller`.

### Task H4: ingress proxy

**Files:**
- Create: `packages/hostd/src/ingress.ts`
- Test: `tests/hostd/ingress.test.ts`

**Interfaces:**
- Consumes: `VmStore` (H2).
- Produces: `createIngress(deps: { store; hostAuthToken: string; tls: { cert; key } })` returns a node `https.Server`. Routing: `host: <handle>.matrix-os.com` maps to the running VM with that handle at `https://<privateIPv4>:443` (the VM's own nginx, self-signed, no verification on the private bridge). The request must carry `x-matrix-host-auth: <hostAuthToken>` (constant-time compare); otherwise 401. A suspended VM returns 503 `{ "error": "runtime_asleep" }`; the ingress never wakes a VM. HTTP and WebSocket upgrades are proxied; `x-matrix-host-auth` is removed before forwarding.

- [ ] **Step 1: Write the failing tests:**
  - `routes by host header to the running VM`
  - `401 without x-matrix-host-auth and does not reach the VM`
  - `503 runtime_asleep for a suspended VM and does not call lifecycle`
  - `404 runtime_unknown for an unknown handle`
  - `proxies a WebSocket upgrade`
  - `strips x-matrix-host-auth before forwarding`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/hostd/ingress.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with node `https` and `http.request` piping; keep a handle-to-record index rebuilt from the store on change.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hostd): add the host ingress proxy`.

### Task H5: hostd API

**Files:**
- Create: `packages/hostd/src/api.ts`, `packages/hostd/src/main.ts`, `packages/hostd/src/config.ts`
- Test: `tests/hostd/api.test.ts`

**Interfaces:**
- Consumes: H2, H3, H4.
- Produces the HTTP API the platform calls (Task P2). Bearer `HOSTD_API_TOKEN`, constant-time compare, on its own TLS port 8443:
  - `POST /v1/vms` with body `CreateVmRequest = { machineId; generation; handle; tier; bootMiB; maxMiB; diskGiB; userData: string (<= 64 KiB); goldenVersion: string }`, returns `201 { id, privateIPv4 }`. Idempotent on `machineId + generation`.
  - `POST /v1/vms/:id/resume` (body `{ budgetMs }`, at most 15000) returns `{ state: 'running' | 'starting' }`.
  - `POST /v1/vms/:id/suspend` returns `202`, then `{ state }` on `GET`.
  - `POST /v1/vms/:id/stop` and `DELETE /v1/vms/:id`.
  - `PUT /v1/vms/:id/policy` with body `{ tier; maxMiB }`.
  - `GET /v1/vms` and `GET /v1/vms/:id`: records without host paths.
  - `GET /v1/capacity` returns `{ memoryAvailableMiB, poolFreeBytes, runningVms, suspendedVms }`.
  - Errors: `{ error: 'unauthorized' | 'bad_request' | 'not_found' | 'busy' | 'pool_full' | 'conflict' | 'internal' }`.

- [ ] **Step 1: Write the failing tests:**
  - `rejects a missing or wrong bearer with 401 before parsing the body`
  - `rejects a body over 64 KiB with 413`
  - `create is idempotent for the same machineId and generation`
  - `create with an older generation returns 409 conflict`
  - `resume clamps budgetMs to 15000`
  - `GET /v1/vms/:id never includes filesystem paths`
  - `an internal error returns { error: internal } without the message`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/hostd/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with Hono, `bodyLimit` and Zod schemas.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hostd): add the authenticated host API`.

### Task H6: host provisioning, golden disk, and live smoke

**Files:**
- Create: `distro/metal-host/provision-host.sh`, `distro/metal-host/build-golden-disk.sh`, `distro/metal-host/nftables.conf`, `distro/metal-host/systemd/matrix-hostd.service`, `distro/metal-host/smoke-host.sh`, `docs/dev/metal-hosts.md`
- Test: `tests/platform/metal-host-scripts.test.ts` (static checks), plus the live smoke

**Interfaces:**
- `provision-host.sh --host-name <fqdn>` is idempotent and does the following:
  - installs pinned Cloud Hypervisor (checksums from S7), the guest kernel and initrd, Node 24 and hostd;
  - creates the `vmvg/pool` thin pool and the snapshot LV;
  - sets up the bridge `brvm` (10.77.0.0/22) and nftables (inputs 22 on tailscale0 only, 443 ingress, 8443 API; per-VM egress shaping 50 Mbit/s; port 25 dropped);
  - adds host zswap and swap.
- `build-golden-disk.sh <bundle-version>` boots a builder VM with the unchanged customer cloud-init and the S7 guest settings, then:
  - installs `linux-modules-extra`, `linuxptp`, `phc2sys-kvm.service` and `matrix-guest-agent.service`;
  - runs `matrix-golden-snapshot-sanitize`;
  - stores the result as read-only LV `golden-<bundle-version>`.

- [ ] **Step 1: Write the failing static test:** `scripts pass bash -n and shellcheck, pin Cloud Hypervisor to v54.1 with a sha256, and never write snapshots under /var/lib/spike`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/platform/metal-host-scripts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the scripts and the runbook in `docs/dev/metal-hosts.md`.
- [ ] **Step 4: Run** the static test. Expected: PASS. Then run the live smoke on the S7 host (51.158.248.135), after moving the four spike VMs to hostd-managed records or rebuilding them: `sudo distro/metal-host/smoke-host.sh`. Expected: it creates a VM from the golden disk, resumes it under 2 s to gateway health, suspends with a sparse snapshot in the pool, and destroys it cleanly.
- [ ] **Step 5: Commit** `feat(distro): provision metal hosts and build golden disks`.

---

## Stack P: platform (`feat/eng-520-metal-*`, based on #3411 once merged)

**Prerequisite:** merge #3411 (`feat/2691-substrate-model`, route machines through runtime substrates) to main after Greptile 5/5. It provides `packages/platform/src/substrates/{types,registry,vps-substrate}.ts` and the `user_machines` substrate columns. Tasks P3, P5 and P7 port named code from the open container stack (#3414, #3415, #3437) and adapt it to `metal`; they cite the source file so reviewers can diff.

### Task P1: metal kind, host registry, and migration

**Files:**
- Modify: `packages/contracts/src/runtime-substrate.ts` (`SubstrateKindSchema` adds `"metal"`), `packages/platform/src/database/migrations/user-machines.ts`, `packages/platform/src/db.ts`
- Create: `packages/platform/src/database/migrations/metal-hosts.ts`, `packages/platform/src/substrates/metal-hosts-repository.ts`
- Test: `tests/platform/metal-hosts-migration.test.ts`, `tests/platform/metal-hosts-repository.test.ts`

**Interfaces:**
- Produces:
  - Table `metal_hosts(id TEXT PK, name TEXT UNIQUE, api_url TEXT, ingress_host TEXT, status TEXT CHECK (status IN ('active','draining','down')), memory_capacity_mib INT, admission_ceiling_mib INT, created_at, updated_at)`.
  - Columns on `user_machines`: `metal_host_id TEXT REFERENCES metal_hosts(id)` and `metal_vm_id TEXT`; the substrate check allows `'metal'`; a check requires `metal_host_id IS NOT NULL` when `substrate = 'metal'`.
  - `createMetalHostsRepository(db)` with `listActive()`, `get(id)` and `upsert(host)`.

- [ ] **Step 1: Write the failing tests:**
  - `migration is idempotent on PGlite and on Postgres`
  - `rejects a metal machine without a host`
  - `existing vps rows are unchanged`
  - `listActive excludes draining and down hosts`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/platform/metal-hosts-migration.test.ts tests/platform/metal-hosts-repository.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): add metal hosts and the metal substrate kind`.

### Task P2: hostd client and metal substrate

**Files:**
- Create: `packages/platform/src/substrates/hostd-client.ts`, `packages/platform/src/substrates/metal-substrate.ts`
- Modify: `packages/platform/src/substrates/platform-substrates.ts` (register `metal` when `METAL_HOSTS_ENABLED=1` and the API and ingress tokens are configured)
- Test: `tests/platform/hostd-client.test.ts`, `tests/platform/metal-substrate.test.ts`

**Interfaces:**
- Consumes: the hostd API (H5) and `MetalHostsRepository` (P1).
- Produces:
  - `createHostdClient(host: MetalHost, token: string)`, mirroring the H5 routes, with 10 s timeouts (resume: `budgetMs + 2000`).
  - `createMetalSubstrate(deps): OnDemandRuntimeSubstrate` with `kind: 'metal'` and `startsOnDemand: true`.
  - `resolveUpstream` returns `{ url: https://<ingress_host>:443<path>, hostHeader: <handle>.matrix-os.com, tlsServerName: ingress_host, headers: { 'x-matrix-host-auth': <token> } }`, or null when the machine is not `running`.
  - `ensureRunning` calls `resume` with `budgetMs: 8000`: `running` maps to `{ state: 'running' }`, `starting` to `{ state: 'starting' }`, `busy` to `{ state: 'busy' }`, and timeout or unreachable to `{ state: 'failed', code: 'provider_unavailable' }`.
  - `stop` calls `suspend`.

- [ ] **Step 1: Write the failing tests:**
  - `resolveUpstream uses the host ingress, never the VM address`
  - `upstream headers carry x-matrix-host-auth`
  - `hostd timeout maps to failed provider_unavailable`
  - `a stale generation from hostd maps to failed needs_recovery`
  - `metal is not registered when its tokens are missing`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** The ingress certificate is verified, unlike VPS TLS (TODO #410).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): add the metal substrate backed by hostd`.

### Task P3: wake on every entry point

**Files:**
- Create: `packages/platform/src/substrates/substrate-wake.ts` (generalized from #3415 `container-wake.ts` and `container-websocket.ts#decideContainerWake`)
- Modify: `packages/platform/src/session-routing-middleware.ts` (the `/vm/<handle>` and app-session paths), `packages/platform/src/platform-websocket-upgrade.ts`, `packages/platform/src/main.ts` (legacy `/proxy/:handle/*`)
- Test: `tests/platform/session-routing-metal-wake.test.ts`, `tests/platform/websocket-metal-wake.test.ts`

**Interfaces:**
- Produces:
  - `prepareOnDemandUpstream(input: SubstrateWakeInput): Promise<SubstrateWakeOutcome>`, keeping #3415's signature with `container` generalized to any `startsOnDemand` substrate.
  - `recordOwnerActivity(db, machineId, now)` updates `last_activity_at`, throttled to one write per machine per 60 s through a capped LRU of 10,000 entries.

- [ ] **Step 1: Write the failing tests:**
  - `owner request to a suspended metal VM resumes it and is proxied in the same request`
  - `concurrent owner requests share one resume`
  - `share-link viewer gets not available and does not wake`
  - `wake taking longer than 8 s returns 503 runtimeState waking with Retry-After 3 for JSON and the boot page for navigation`
  - `WebSocket upgrade to a suspended VM waits for resume, then upgrades`
  - `owner requests update last_activity_at at most once per minute`
  - `vps machines are untouched`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Native Mobile (`apps/mobile/lib/gateway-client.ts`, `/vm/<handle>`) and the CLI (`app.matrix-os.com`) already route through these paths, so no client bypasses the wake.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): wake on-demand runtimes for every owner entry point`.

### Task P4: metal provisioning and registration

**Files:**
- Create: `packages/platform/src/substrates/metal-provisioner.ts`
- Modify: `packages/platform/src/customer-vps-schema.ts` (the register request becomes a discriminated union on `provider: 'hetzner' | 'metal'`; the metal variant carries `serverRef: string` and no public IPv4), `packages/platform/src/customer-vps-registration.ts` (match on `metal_vm_id` for metal rows), `distro/customer-vps/host-bin/matrix-register-vps` (when `MATRIX_SERVER_PROVIDER=metal`, send `provider: metal, serverRef: $MATRIX_SERVER_REF` and skip Hetzner metadata)
- Test: `tests/platform/metal-provisioner.test.ts`, `tests/platform/customer-vps-registration-metal.test.ts`, `tests/platform/register-vps-script-metal.test.ts`

**Interfaces:**
- Produces: `createMetalProvisioner(deps)` with `provision(input: { clerkUserId; handle; tier: 'free' | 'paid' }): Promise<{ machineId } | { error: 'busy' | 'unavailable' }>`.
  - Placement picks the active host with the most `memoryAvailableMiB` above its `admission_ceiling_mib` and `poolFreeBytes > 200 GiB`.
  - It renders user data with the existing `renderCloudInitTemplate`, adding `MATRIX_SERVER_PROVIDER=metal` and `MATRIX_SERVER_REF`.
  - It inserts the `user_machines` row (`substrate: 'metal'`, `status: 'provisioning'`) in a transaction before calling hostd `create`.

- [ ] **Step 1: Write the failing tests:**
  - `places on the host with the most headroom`
  - `returns busy when no host is under its ceiling`
  - `a hostd create failure marks the row failed and queues destroy`
  - `registration accepts metal with serverRef and rejects a wrong serverRef`
  - `hetzner registration is unchanged`
  - `register script sends the metal variant when MATRIX_SERVER_PROVIDER=metal`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): provision and register metal runtimes`.

### Task P5: free plan on metal

**Files:**
- Create (ported from #3414 `packages/platform/src/free-tier/*` and `database/migrations/free-tier.ts`): `config.ts`, `free-entitlement.ts`, `invites.ts`, `provision-free-route.ts`, `provision-free-runtime.ts`; the provisioner calls `MetalProvisioner` instead of the container provider and owner database.
- Modify: `packages/platform/src/runtime-entitlement.ts` (a free entitlement allows `provision-runtime` for `substrate: metal`), `packages/platform/src/app-session-routes.ts:145` (no `402 billing_required` for an entitled free user)
- Test: ported `tests/platform/free-tier-*.test.ts` from #3414, plus `tests/platform/free-tier-metal.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `an invited user without billing provisions a free metal runtime`
  - `an uninvited user gets 402 billing_required as today`
  - `a second provision returns the existing runtime (idempotent through the unique index)`
  - `FREE_TIER_ENABLED=0 disables free provisioning`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the port.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): add the free plan on metal runtimes`.

### Task P6: idle sleeper and scheduled wakes

**Files:**
- Create: `packages/platform/src/substrates/metal-sleeper.ts`
- Modify: `packages/platform/src/platform-startup.ts` (start the worker; clear its timer on shutdown), the migration from P1 (columns `next_wake_at TIMESTAMPTZ` and `awake_since TIMESTAMPTZ`)
- Test: `tests/platform/metal-sleeper.test.ts`

**Interfaces:**
- Consumes: the gateway lifecycle endpoint (G1) through the substrate upstream, and `MetalSubstrate.stop` and `ensureRunning`.
- Produces: `createMetalSleeper(deps)` with `tick(now)`, run every 60 s, single-flight. For each running free metal machine:
  - If `last_activity_at` is older than 60 min, read the lifecycle.
  - If `busy`, skip, unless `awake_since` is 6 h or more with no owner activity; then suspend and flag `idle_guard`.
  - Otherwise record `next_wake_at = nextScheduledAt - 60 s` and call `stop`.
  - Machines with `next_wake_at <= now` get `ensureRunning`.

- [ ] **Step 1: Write the failing tests:**
  - `sleeps a free VM idle for 60 minutes with nothing running`
  - `does not sleep while lifecycle reports busy`
  - `suspends and flags after 6 hours awake with no owner activity`
  - `never sleeps paid VMs`
  - `wakes 60 s before nextScheduledAt`
  - `sleeper leaves running on suspend failure`
  - `lifecycle timeout skips the machine this tick`
- [ ] **Step 2: Run** `pnpm exec vitest run tests/platform/metal-sleeper.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** State changes use compare-and-set on `(status, generation)`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): sleep idle free runtimes and wake them for scheduled work`.

### Task P7: free Matrix AI funding

**Files:** port #3437 (`fund free runtimes' Matrix AI through a prepaid usage...`), keeping its tests and replacing container-only checks with `substrate IN ('container','metal')` (later only `metal`).

- [ ] **Step 1: Port the tests from #3437** and add `a metal free runtime receives the starter credit on registration`. **Step 2:** run them; expected FAIL. **Step 3:** port the code. **Step 4:** run them; expected PASS. **Step 5: Commit** `feat(platform): fund free metal runtimes' Matrix AI`.

---

## Stack G: gateway and clients (`feat/eng-520-gateway-*`)

### Task G1: lifecycle endpoint

**Files:**
- Create: `packages/gateway/src/server/lifecycle-routes.ts`, `packages/gateway/src/lifecycle/status.ts`
- Modify: `packages/gateway/src/cron/service.ts` (add `nextRunAt(): Date | null` across jobs; node-cron v4 `ScheduledTask.getNextRun()`; `once` uses its time; `interval` uses `lastRunAt + interval`), `packages/gateway/src/bots/repositories/routines.ts` (add `nextFireAt(): Promise<Date | null>`)
- Test: `tests/gateway/lifecycle-status.test.ts`, `tests/gateway/lifecycle-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/system/lifecycle`, through the existing `authMiddleware`, returning `{ busy: boolean, busyReasons: Array<'chat_run' | 'terminal_attached' | 'background_agent' | 'routine'>, nextScheduledAt: string | null }`.
  - Busy when a `chat_runs` row is `accepted`, `running`, `waiting_for_approval` or `waiting_for_input`; or a terminal session has `attachedClients > 0`; or a background agent `isRunning`; or a routine is executing.
  - `nextScheduledAt` is the minimum over cron, routines and heartbeat.

- [ ] **Step 1: Write the failing tests:**
  - `busy with chat_run while a run is running`
  - `not busy with only waiting runs older than 24 h` (stale rows must not pin a VM awake)
  - `nextScheduledAt is the earliest of cron and routine`
  - `401 without auth`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): report lifecycle busy state and the next scheduled time`.

### Task G2: catch up missed cron runs

**Files:**
- Modify: `packages/gateway/src/cron/service.ts`, `packages/gateway/src/cron/store.ts` (persist `lastRunAt` per job)
- Test: `tests/gateway/cron-catch-up.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `a cron job whose occurrence passed while stopped runs once on start`
  - `two missed occurrences still run only once`
  - `an interval job missed while stopped runs once on start`
  - `a job never run before does not run on start`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement:** on `start()`, compare `lastRunAt` with the previous occurrence.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `fix(gateway): run missed cron jobs once after the runtime was asleep`.

### Task G3: clients retry while waking

**Files:**
- Modify: `apps/mobile/lib/gateway-client.ts`, `packages/sync-client/src/lib/` (HTTP client used by `matrix run`, `shell`, `sync`)
- Test: `apps/mobile/__tests__/gateway-client-waking.test.ts`, `tests/sync-client/waking-retry.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `retries a 503 with runtimeState waking after Retry-After, up to 30 s total`
  - `does not retry a 503 runtime_unavailable more than once`
  - `shows the waking state after 3 s` (mobile)
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(clients): wait for a waking Matrix computer instead of failing`.

---

## Task E2E: staging end-to-end (after H, P, G merge or on their branches)

- [ ] **Step 1:** Build a dev host bundle from the merged branches (`./scripts/build-host-bundle.sh`) and the golden disk for it on the S7 host (`build-golden-disk.sh <version>`).
- [ ] **Step 2:** Deploy a preview platform revision with `METAL_HOSTS_ENABLED=1`, `FREE_TIER_ENABLED=1`, hostd and ingress tokens, the S7 host in `metal_hosts`, and an invite for Hamed's account.
- [ ] **Step 3:** Hamed runs the checklist, with evidence per surface:
  - sign up free;
  - Chat with Matrix AI;
  - Terminal with `claude` installed;
  - Files;
  - Native Mobile chat and terminal;
  - `matrix run -it -- bash` from the CLI;
  - a cron job every 15 minutes writing a file;
  - leave for 70 minutes, then confirm the VM slept, the cron file kept updating, and the first request woke it in under 2 s.
- [ ] **Step 4:** Record the results in `spikes/s7-bare-metal-vms.md` ("Staging end-to-end") and attach evidence to the PRs.

## Not in this plan (next plan)

Upgrade to paid (plan record, `PUT /v1/vms/:id/policy`, no sleep), second host and private network, cross-host moves, host-loss restore drill, storage tiers (cold sleep and R2 archive), the abuse detector beyond shaping and the 6 h guard, the production rollout (AGENTS.md amendment, runbook, invite list), and closing the superseded container PRs (#3412, #3413, #3416 to #3419).
