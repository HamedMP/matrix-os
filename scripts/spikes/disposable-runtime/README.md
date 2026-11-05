# Disposable runtime experiment

Trusted synthetic workload only. No production endpoints, real user data,
provider credentials or AI calls. Use a disposable Linux host with Node 24+ and
Docker, not a customer VPS. Ordinary Docker on a shared kernel is not the
proposed security boundary for mutually untrusted customer code.

## Run

```bash
node scripts/spikes/disposable-runtime/benchmark.mjs --output /tmp/runtime-evidence.json
node scripts/spikes/disposable-runtime/cost-model.mjs
pnpm exec vitest run tests/spikes/disposable-runtime.test.ts tests/spikes/disposable-runtime-cost.test.ts
```

The benchmark pulls `node:24-bookworm-slim` and `postgres:17-bookworm` before
timing and records their immutable digests. It runs three cycles each at 1 MiB
and 16 MiB, with 1,000 SQL rows. Node and Postgres containers each have a 256 MiB
limit and 1 CPU limit; this says nothing about the full Matrix runtime's limits.
All fixture ports are local to the test host and protected by a random bearer
credential. SQL is manipulated by the controller, not the fixture HTTP server.

Evidence includes file/SQL checksums, fresh container and volume identities,
checkpoint/destroy/restore timings, 20 warm health samples per phase, Node RSS,
and Docker working-set memory. Container health is separate from desktop boot.
The fixture's database is synthetic; Matrix's actual schema/migrations, agent
processes, terminal recovery, R2 durability and concurrent writes are untested.

## Test whole-machine destruction

```bash
# Source test host; choose a checkpoint directory that does not already exist.
node scripts/spikes/disposable-runtime/benchmark.mjs --save-only --checkpoint-root /tmp/matrix-checkpoint --output /tmp/save-evidence.json
# Copy the complete checkpoint plus evidence to independent durable storage.
# Verify the copied files/checksums before deleting ONLY the disposable source.
# Create a new disposable host, install prerequisites, copy scripts/checkpoint.
node scripts/spikes/disposable-runtime/benchmark.mjs --restore-only --checkpoint-root /tmp/matrix-checkpoint --output /tmp/restore-evidence.json
```

Source containers AND writable volumes are destroyed after checkpoint validation.
Restore verifies file hashes and owner identity before allocating containers.
The controller checks a file hash and a checksum over all SQL rows, then confirms
new writes. The manifest is trusted operator input; checksums detect accidental
corruption, not maliciously rewritten manifests. Do not expose this tool as a
user-supplied archive restoration API.

Default checkpoints remain in the exact `checkpointRoot` returned in evidence.
Explicit checkpoint paths also remain for cross-host transfer. After copying
evidence, delete those experiment directories or delete the whole disposable
host. On failure, containers/volumes remain for diagnosis; remove only resources
with the experiment's exact `matrix.spike` ownership label. Never sweep all Docker
resources on a shared machine. Delete temporary cloud servers, allocated IPs and
the experiment SSH key immediately after validation; never delete existing hosts.

Cost JSON has explicit hypothetical workload, occupancy and concurrency inputs.
It excludes AI, durable databases/files and shared service costs. Provider minimum
charges and list prices are not measured wake latency or a production cost quote.
See `specs/548-disposable-runtime-spike/report.md` and `providers.md` for the
decision, limits and captured results.
