---
status: completed
---

# Disposable runtime spike

Goal: validate an immediate Web Desktop backed by on-demand compute for Free and
Starter, coexisting with always-on personal computers for Builder and Max.
This is an experiment with synthetic data, not a production runtime rollout.

## Implementation units

### U1: Reproducible save/destroy/restore benchmark

Files: `scripts/spikes/disposable-runtime/benchmark.mjs`,
`scripts/spikes/disposable-runtime/runtime.mjs`,
`tests/spikes/disposable-runtime.test.ts`.

Approach: run a bounded synthetic Node workload and real Postgres in isolated
Docker containers on a disposable Linux host. Persist files and database dump
outside runtime containers; delete containers AND their writable volumes; restore
into fresh containers. Check exact acknowledged rows/files, mutations after wake,
and that failures prevent destructive transitions. Measure checkpoint, restore,
readiness and container memory separately. Clearly distinguish this small
fixture from the full Matrix gateway and from a production sandbox boundary.

Execution note: tests first; verify red before implementing. Test scenarios:
round-trip integrity, corrupt backup fails closed, owner mismatch fails closed,
bounded cleanup, and a real Postgres/container integration run. Verification:
focused Vitest tests plus machine-readable remote experiment evidence.

### U2: Provider feasibility and reproducible cost comparison

Files: `scripts/spikes/disposable-runtime/cost-model.mjs`,
`tests/spikes/disposable-runtime-cost.test.ts`,
`specs/548-disposable-runtime-spike/providers.md`.

Approach: current official pricing/capability sources for Hetzner ephemeral VPS,
pooled execution, Google Cloud Run, AWS Lambda, Cloudflare Workers/Containers.
Calculate explicit Free/Starter assumptions, hourly rounding, pool utilization,
per-request versus instance billing, storage, and exclusions. Do not represent
published rates or model outputs as measured provider performance.

Execution note: tests first, verify red before implementing. Test scenarios:
VPS hourly rounding/monthly caps, concurrent capacity and pool baseline,
serverless units, invalid/non-finite inputs. Verification: focused tests and
reproducible scenario output with source links and observation date.

### U3: Execute experiment and architecture decision

Files: `specs/548-disposable-runtime-spike/report.md`, sanitized evidence JSON,
and this plan's final status.

Approach: provision only a temporary labeled host with a dedicated temporary SSH
key, execute U1, delete all temporary cloud resources. Record platform shape,
sample count, memory metric and measured timing boundaries. Document immediate
desktop boot independently of compute; common workspace identity, placement,
leases, durable data and upgrade migration; explicit restrictions for sleeping
workspaces and strong isolation required for untrusted code. No production
endpoints, billing changes, real user data or public-facing free-plan promises.

Verification: inspect all evidence; validate cleanup; review and create PR with
required invariants. Follow-up implementation must include auth matrix, TDD,
surface parity, real Matrix workload benchmarks, and a separate documentation PR
in `FinnaAI/matrix-os-site/content/docs/` before public release.

## Progress tracking

Execution progress is recorded in commits and the final report. No public docs
change is warranted for an internal experiment that does not ship a capability.
