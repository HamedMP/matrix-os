# Shared runtime cost illustration

Observed prices: **2026-10-18**, USD, before tax. These are modeled marginal
container charges, not Cloudflare invoice measurements or plan entitlements.

## Billing model

Cloudflare bills **provisioned memory and allocated disk while running**, even
when the agent is waiting for inference. CPU charges follow actual CPU use.
Sleeping stops container compute charges. Billing granularity is 10 ms.
[Official container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

| Resource | Rate | standard-1 | standard-2 |
|---|---:|---:|---:|
| Memory | $0.0000025 / GiB-second | 4 GiB | 6 GiB |
| CPU | $0.000020 / active vCPU-second | 0.5 vCPU maximum | 1 vCPU maximum |
| Disk | $0.00000007 / GB-second | 8 GB | 12 GB |

Shapes match [current instance limits](https://developers.cloudflare.com/containers/platform/limits/).
Observed RSS does **not** replace provisioned memory.

Assume 15 seconds of startup plus 15 seconds of idle grace for every session,
with evenly divided task time. Checkpoint work must fit those overheads; extra
time costs more. Overheads and CPU duty are unmeasured assumptions.

| Scenario | Task time/month | Sessions/month | Resident seconds including overhead |
|---|---:|---:|---:|
| Illustrative Free | 30 minutes | 20 | 2,400 |
| Illustrative Starter | 10 hours | 100 | 39,000 |

```text
T = task_seconds + sessions × (15 startup_seconds + 15 idle_seconds)
container_USD = T × (memory_GiB × 0.0000025
                    + disk_GB × 0.00000007
                    + maximum_vCPU × CPU_duty × 0.000020)
```

CPU duty 0.05 means 5% of CPU capacity over resident time. Duty 1 is the
full-utilization bound for the same duration, not the whole service bill.

| Per account/month, container only | Free, 5% CPU | Free, full CPU | Starter, 5% CPU | Starter, full CPU |
|---|---:|---:|---:|---:|
| standard-1 | $0.026544 | $0.049344 | $0.431340 | $0.801840 |
| standard-2 | $0.040416 | $0.086016 | $0.656760 | $1.397760 |

No included allocations or discounts are applied. Cloudflare's $5/month Workers
Paid baseline and included usage are account-wide, not a fresh allowance for each
Matrix owner. Worker requests/CPU, Queues, R2 storage/operations, Durable Object
requests/duration/storage, network egress, logs, shared Postgres capacity,
authentication, backups, redundancy, AI and operations are **additional costs**.
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

A continuously active controller also incurs Durable Object duration charges.
At the published 128 MB allocation and $12.50/million GB-seconds, a simple
fleet-attribution estimate is `T × 0.128 × 12.50 / 1,000,000`: $0.003840 Free or
$0.062400 Starter. These amounts are excluded above. Actual invoices apply shared
included usage and round billable duration upward to million-GB-second units;
these are not standalone per-owner invoice quotes. Hibernate eligible idle
controllers; browser polling must not renew an execution lease.
[Durable Object billing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Ephemeral VPS comparison

Reusing PR #2700's recorded CX23 assumptions ($0.0104/hour, $6.49/month cap), one
fresh VPS creation per session costs **$0.208 Free** or **$1.040 Starter** for the
new scenarios above. Every session is below one hour, but each creation rounds
up to one billed hour. The monthly cap applies separately to each server, not
the sum of replacements. Merely powering off a server still incurs charges.
[Hetzner billing](https://docs.hetzner.com/cloud/billing/faq/),
[prior model and assumptions](https://github.com/HamedMP/matrix-os/blob/codex/disposable-runtime-spike/specs/548-disposable-runtime-spike/cost-evidence.json)

These workloads differ from PR #2700. VPS availability, CPU throughput, memory
shape and cold-start behavior are not equivalent.
PR #2700 measured fresh-VPS bootstrap around 65–73 seconds with a synthetic
fixture; it did not establish an actual Matrix remote wake time.

## Measured workload and decision

The local actual-Matrix gateway/agent test recorded a **30.7-second task**,
**1.41 GiB peak container memory**, and **$0.0453432 AI usage**. This single task is not a monthly average; its AI cost exceeds either
5%-CPU Free subtotal above.

At this report's preparation, remote Cloudflare container wake was still
unmeasured, pending approval to install the isolated preview's required secrets.
Neither the 15-second startup assumption nor production-scale isolation,
checkpoint overhead or utilization has been verified remotely.

**Sleeping accounts can have almost zero marginal container cost.** Durable
storage and shared services still cost money. A viable Free plan therefore needs
bounded task time, storage, concurrency and AI spend; always-on services remain
paid compute. Shared runtimes and personal VPSes coexist in the product with
separate API placements. Migrating or synchronizing their data is a follow-up.
