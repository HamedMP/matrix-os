# ENG-288: CPU capacity provenance

Refs: https://linear.app/matrix-os/issue/ENG-288/reconcile-displayed-and-runtime-cpu-core-counts

Repair only the proven source defect: visible logical CPU topology is not effective runtime capacity. The customer's exact 4-vs-8 incident remains unproven and needs paired selected/API/terminal/platform-machine provenance before ticket closure.

## Contract

One shared pure derivation intersects observed CPU capacity bounds: visible topology, process affinity, effective eligible cpuset counts, and every accessible ancestor CPU quota. Quotas remain fractional CPU-time equivalents. They are not physical cores, throughput guarantees, billing entitlements, or provisioned server-type assertions. Missing, malformed, oversized or unreadable required observations yield explicit unknown capacity, never unlimited.

Collect constraints for the gateway process, not an arbitrary terminal, agent sandbox or host service. Linux cgroup v1/v2 discovery comes from bounded proc membership/mount records; walk only within the matching mount, bounded to 64 ancestors. Uninspectable ancestry yields unknown. Other OSes use native available parallelism and explicitly inapplicable Linux constraints.

Add capacity provenance to system info and activity; retain legacy cpuCount/cores as visible topology for older clients. New clients treat an older gateway's absent provenance as unknown effective capacity. Shared presentation and load normalization preserve fractions, including values below one. Platform probes forward validated observations without deriving capacity from plan metadata.

## Security and wiring

Existing authenticated GET /api/system/info and GET /api/system/activity retain their auth design. No endpoints, inputs, writes, caches or resource mutations are added. Kernel-owned proc/sys files are read synchronously in bounded buffers; paths must match discovered cgroup mounts and stay within them. No provider errors or filesystem paths are returned to clients. Collection failure is a coarse unknown observation. Activity reuses system info's observation, not a second independent CPU count.

## Validation and scope

Red tests cover affinity/cpuset-only, quota-only, tighter ancestors, fractions, unknown constraints, endpoint wiring, older gateways and shared display semantics. Monitor tests include load 0.25 / capacity 0.5 = 50%. Reader tests cover discovery, hierarchy, malformed/unreadable input and bounded traversal.

Affected surfaces: Electron System, Web Canvas/Web Desktop/Web Mobile when hosting Resource Manager, web Activity Monitor and web runtime banner. Native Mobile System has no CPU display; review architectural non-applicability rather than adding a new feature. Test rendering is not live qualification. Current-build screenshots and recordings for each applicable surface, plus evidence sharing through the repository workflow, remain required for merge readiness. No deployment is authorized by this work.

Recommend engineering/product review of scope and vocabulary. Public documentation is a separate PR in FinnaAI/matrix-os-site explaining topology, effective CPU-time capacity and unknown release-skew states. No resize, plan/billing mutation, Hetzner operation or unrelated information redesign.

## Hierarchy provenance

Linux reports complete ancestry only in its initial cgroup namespace, identified by the kernel UAPI CGROUP_NS_INIT_INO (0xEFFFFFFB). Private namespaces and unreadable namespace identity yield unknown even when proc membership and mount roots both read `/`. The real v2 root has no CPU bandwidth quota; exclude it from quota reads while retaining every enforceable parent. Explicit controller availability/delegation distinguishes disabled interfaces from unreadable active constraints. Shared presentation code participates in Resource Manager's incremental source hash.

References: [Linux namespace UAPI](https://github.com/torvalds/linux/blob/master/include/uapi/linux/nsfs.h), [cgroup v2 CPU controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu), [systemd namespace identity](https://github.com/systemd/systemd/blob/main/src/basic/namespace-util.c).
