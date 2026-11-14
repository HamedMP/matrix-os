# Disposable runtime provider comparison

Observed **2026-10-18**, USD list prices before tax. This document and
`cost-model.mjs` model costs; they do **not** measure provider wake time or prove
full Matrix workload compatibility. The separate experiment report contains the
actual save/destroy/restore measurements.

## Decision

Keep one Matrix product with two placement policies: **shared, sleeping compute**
for Free/Starter and **dedicated, always-on computers** for higher plans. Evaluate
Cloudflare Linux Sandboxes and a strongly isolated host pool with the real kernel
next. Default Lambda functions are useful for bounded jobs; they require much more
task decomposition than the existing Linux runtime. Cloud Run can serve queued
container work but needs explicit durable state and background lifecycle design.
These are engineering conclusions from the documented constraints below, not a
provider performance ranking.

Common workspace identity, owner data, auth, quota/reservations, runtime leases,
placement and routing must be independent of a server ID. An upgrade fences the
old writer, checkpoints, restores on dedicated placement and changes routing.
Both placements use the same gateway/kernel contracts and shells. Shared means
sharing underlying capacity, never sharing owner credentials or an untrusted
process environment. Do not use ordinary Docker separation as the production
security boundary for arbitrary customer code.

An immediate Web Desktop requires shared authenticated APIs for its initial
state, files, app metadata, chats and placement status. Serving the shell HTML
alone cannot make a sleeping user's data available. Agent/terminal actions enqueue
durable work and acquire compute; a browser disconnect must not cancel that work.
Sleeping workspaces cannot promise persistent terminals, hosted servers, or
unlimited bots. Accepted writes must be durable before acknowledgement; checkpoint
at deliberate sleep is additional protection, not the only crash recovery path.

## Prices and lifecycle evidence

| Candidate | Published or API-observed rate | Relevant constraint |
|---|---|---|
| Hetzner CX23, Helsinki `hel1` | 2 shared vCPU, 4 GB RAM, 40 GB disk; $0.0104/hour, $6.49/month | API showed capacity only in `hel1` among inspected EU locations. Every creation rounds up to whole hours; retained powered-off servers remain billable. |
| Hetzner CX33 pool hypothesis | 4 shared vCPU, 8 GB RAM, 80 GB disk; $0.016/hour, $9.99/month | No capacity in `fsn1`, `nbg1`, or `hel1` at observation. Price is not an obtainable-capacity promise. |
| Hetzner CX43 alternative | 8 shared vCPU, 16 GB RAM, 160 GB disk; $0.0296/hour, $18.49/month | Same inspected EU capacity limitation. Not used in default calculation. |
| Cloud Run services, Tier 1 `us-central1` | Request mode: $0.000024/vCPU-second, $0.0000025/GiB-second, $0.40/million requests. Instance mode: $0.000018/vCPU-second, $0.000002/GiB-second | 100 ms rounding; instance mode has a one-minute minimum per instance. These are US-region comparison rates, not a European residency quote. |
| Lambda default on-demand, x86 `us-east-1` | $0.0000166667/GB-second, $0.20/million invocations; extra scratch above 512 MB $0.0000000309/GB-second | Millisecond duration billing; 900-second invocation maximum. Not Lambda Managed Instances, Durable Functions, or MicroVM products. |
| Cloudflare Containers, global rate | $0.000020/active vCPU-second; $0.0000025/provisioned GiB-second; $0.00000007/provisioned GB-second disk | 10 ms billing while running; RAM/disk still cost money when CPU is idle. Workers Paid has a shared $5/month minimum. |

Hetzner rates/shapes/capacity were read from the authenticated
[Cloud API server-types and locations endpoints](https://docs.hetzner.cloud/reference/cloud#server-types-get-all-server-types)
by the spike operator, excluding separately billed IPv4. Billing caps apply per
server within a billing month, never across an owner's repeated creations.
[Hetzner billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

Cloud Run request mode allocates CPU while processing a request, starting or
shutting down. Returning a response and then continuing an agent in the background
does not provide that CPU allocation. Instance mode bills the whole lifecycle.
Free allowances are billing-account totals, not entitlements for each Matrix user.
[Cloud Run prices](https://cloud.google.com/run/pricing),
[billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings).
Services have a configurable request timeout up to 60 minutes. Their local writable
filesystem consumes RAM and disappears on stop; termination normally gives a
10-second signal window. Queue retries, external files/Postgres, idempotency and
continuous durable writes are required.
[Request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout),
[container contract](https://docs.cloud.google.com/run/docs/container-contract).

Default Lambda functions offer 128 MB–10,240 MB memory, proportional CPU (about
one vCPU at 1,769 MB), 512 MB–10,240 MB scratch, and a 1,024 process/thread limit.
They may freeze/reuse execution environments; `/tmp` survival is a cache behavior,
not durable owner storage. Background children must not be relied on between
invocations. A 20-minute Starter task cannot run unchanged in one standard
invocation. Managed Instances and durable workflows have different limits and
charges; their existence does not remove the default function's constraints.
[Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html),
[execution lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html),
[Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Workers isolates have 128 MB memory and limited CPU; they are a useful front door,
not the existing Node/Agent SDK plus terminal Linux environment.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
Cloudflare's Linux sandbox instances instead use microVMs with their own kernel
and network. Current sandbox Durable Object scheduling is **public beta**; do not
treat the earlier Containers GA announcement as a guarantee for that policy.
[Sandboxes overview](https://developers.cloudflare.com/sandbox/).
An open terminal keeps compute resident. Interior processes alone do not keep
the sandbox active; background work needs a coordinator/alarm. Sleep loses live
processes; snapshots restore disk files, not a running terminal or database's RAM.
[Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/).

The comparison uses the documented `standard-1` size: 0.5 vCPU, 4 GiB, 8 GB disk.
It is **not resource-equivalent** to the 1 vCPU/2 GiB target elsewhere; no equal
throughput is asserted. A custom 1 vCPU type requires at least 3 GiB RAM. Snapshot
retention is currently 30 days (refreshed by restore), so provider snapshots alone
cannot promise indefinite inactive-owner retention.
[Container sizes and limits](https://developers.cloudflare.com/containers/platform/limits/).
Default costs below exclude shared allowances, Workers/DO requests and DO duration,
logs and network. Validate regional placement/residency before adoption; global
pricing is not a residency guarantee.
[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/).

## Reproduce the illustrative comparison

```bash
node scripts/spikes/disposable-runtime/cost-model.mjs
```

One modeled month is 730 hours. Each activation includes **one hypothetical minute
for all start/checkpoint/restore/shutdown work** and a **five-minute idle tail**.
These values must be replaced with actual full-workload measurements. Memory target
is 2 GiB; CPU capacity budget is 1 vCPU, except the Cloudflare size above.

| Illustrative plan workload | Useful task time | Total resident time |
|---|---:|---:|
| Free: 20 activations × 5 minutes | 1.667 hours/month | 3.667 hours/month |
| Starter: 60 activations × 20 minutes | 20 hours/month | 26 hours/month |

These are hypothetical workload scenarios, **not proposed published allowances**.
Cloud Run request mode counts task plus lifecycle time and no idle tail, assuming
a durable dispatcher holds a request until completion. Instance mode and
Cloudflare include the idle tail. Cloudflare assumes average CPU use of 0.2 vCPU
during task/lifecycle time, zero CPU in idle tails. Lambda splits work into
five-minute tasks plus one minute overhead **per chunk**, requiring an explicit
refactor/checkpoint protocol; Starter uses 240 invocations. AI waiting remains
billed wall time on duration-based services.

| Compute only, USD per active account/month | Free | Starter | Free $/useful hour | Starter $/useful hour |
|---|---:|---:|---:|---:|
| Create/delete a CX23 each activation | 0.208 | 0.624 | 0.1248 | 0.0312 |
| CX33 pool, 1,000 accounts under stated peak | 0.170 | 0.340 | 0.1019 | 0.0170 |
| CX33 pool, only 10 accounts | 0.999 | 0.999 | 0.5994 | 0.0500 |
| Cloud Run request mode | 0.209 | 2.192 | 0.1253 | 0.1096 |
| Cloud Run instance mode | 0.290 | 2.059 | 0.1742 | 0.1030 |
| Lambda, explicitly decomposed tasks | 0.240 | 2.880 | 0.1440 | 0.1440 |
| Cloudflare standard-1 variable usage | 0.168 | 1.291 | 0.1009 | 0.0645 |

Cloudflare adds the shared $5/month baseline and related service charges; model
usage at list rates deliberately does not subtract its included usage. All
providers' free allowances are finite and shared, not multiplied by account count.
Inactive-account compute can approach zero on scale-to-zero products; it does not
eliminate shared baseline or retained data costs.

## Pool capacity and idle cost

The hypothetical CX33 pool reserves 1 GiB and 1 vCPU per host for OS, scheduler and
isolation overhead. Remaining 7 GiB/3 vCPU permits **three** 2 GiB/1 vCPU concurrent
slots. This is a resource budget, **not measured safe density or equal performance**
on shared vCPUs. MicroVM overhead/security compatibility need separate validation.

Hetzner explicitly does not support nested virtualization on Cloud servers.
Consequently the CX33 pool numbers are a **container-capacity arithmetic baseline,
not a deployable Firecracker/KVM pool quote**. A production pool would require a
validated userspace-kernel sandbox, compatible bare-metal hosts, or a managed
microVM service; its cost must be recalculated with that actual isolation layer.
Also, CX23 has 40 GB disk versus the current European Starter's 80 GB: it is not
a compatible in-place downgrade. Existing-data migration and storage limits need
separate validation.
[Hetzner server FAQ](https://docs.hetzner.com/cloud/servers/faq/).

Host count is the maximum of: one retained host; `ceil(peak/slots)`; and
`ceil(total_resident_hours/(slots × month_hours × 0.5))`. The last term targets at
most 50% average occupancy. Peak assumptions are 5% of Free accounts or 10% of
Starter accounts concurrently resident. They are assumptions, not traffic forecasts.

At 1,000 Free accounts this provisions 17 hosts/51 slots, bills **$169.83**, and
uses only **9.85%** of 37,230 paid slot-hours. At 1,000 Starter accounts it provisions
34 hosts/102 slots, bills **$339.66**, and uses **34.92%** of 74,460 slot-hours.
Peak demand, rather than average volume, sets both fleets. Smaller fleets still
pay the whole $9.99/month host baseline. A mixed fleet can reuse capacity but only
with measured joint peak distribution; do not sum independently discounted
per-account estimates and assume free burst capacity. Overflow requires queues,
admission control or paid autoscaling. No redundancy is included in these numbers.

## Costs deliberately outside the compute table

Durable owner Postgres, files, checkpoint history, API/auth services, AI, network,
IPv4, logs, backup operations, redundancy, tax and engineering operations remain.
For scale: R2 Standard storage is $0.015/GB-month, plus $4.50/million Class A and
$0.36/million Class B operations before shared allowances and billing rounding.
It is not a Postgres replacement. Versioned checkpoints multiply retained bytes;
repeated full snapshots multiply transfer and operation work.
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The cheap VPS path may be attractive in compute dollars while failing wake-time,
capacity, isolation or operator-effort requirements. The model alone does not pick
a winner. Next compare the same real Matrix workload with SDK child processes,
build tools, terminal reconnect, durable Postgres, realistic files and fault
injection across an available pooled sandbox and Cloudflare/Cloud Run deployment.
