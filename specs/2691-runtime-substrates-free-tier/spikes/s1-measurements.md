# S1 measurements: AWS Lambda MicroVMs and Cloud Run gen2

Measured 2026-11-10 with a 1.5 GB probe image (Node HTTP and WebSocket server, Postgres
client, bubblewrap, the production launcher preflight). This is not the gateway image.
Cloud Run was timed from a VM in europe-west1. Lambda MicroVMs was timed from a
developer machine, so its figures include internet latency.

## Wake time to interactive (first WebSocket echo)

| Path | Trials | Median | Worst | Over 5 s |
| --- | --- | --- | --- | --- |
| Lambda MicroVMs, cold run from image | 20 | 2.6 s | 3.0 s | 0 |
| Lambda MicroVMs, resume after 5 min suspended | 10 | 0.95 s | 3.1 s | 0 |
| Lambda MicroVMs, cold, gateway process started after restore | 20 | 2.9 s | 5.3 s | 1 |
| Cloud Run, manual scaling 0 to 1 | 20 | 1.7 s | 33 s | 4 |
| Cloud Run, request-triggered from zero | 20 | 0.66 s | 98 s | 9 |
| Cloud Run, request-triggered, longer idle | 9 of 10 | 6.0 s | 67 s | 5, plus 1 failure |

The cause of the Cloud Run tail is not established.

## Hard criteria

| Criterion | Lambda MicroVMs | Cloud Run gen2 |
| --- | --- | --- |
| Non-root user namespaces (`bwrap --unshare-all`) | Pass | Pass |
| Production launcher preflight, hardened variant | Pass after two launcher fixes and with all capabilities kept; default capabilities deny a fresh `/proc` | Pass as built |
| Egress default deny, allowlist, Postgres on 5432 | Pass | Pass |
| Cross-tenant call rejected | Pass (403) | Pass (403 with another tenant's identity) |
| WebSocket held 15 minutes | Pass | Pass |
| Scale to zero, EU region, lifecycle API | Pass | Pass |

## Other findings

- Neither provider delegates cgroup v2, so the agent workload has rlimits and tmpfs
  size limits only.
- Lambda MicroVMs units restored from one snapshot repeat `crypto.randomBytes`,
  `randomUUID`, and `Math.random` values (2 distinct values across 20 units). Only
  `/dev/urandom` read after restore is unique. Starting a fresh Node process after
  restore gives 20 distinct values of 20. Cloud Run units were all distinct.
- Lambda MicroVMs limits: 8 hour unit lifetime including suspended time, endpoint token
  at most 60 minutes, start hook at most 60 seconds.
- Cloud Run limits: 60 minute WebSocket cap; the front end reserves paths ending in
  `z`, so `/healthz` never reaches the container; the metadata server issues tokens for
  the runtime service account, which must hold no roles.
- List price per active hour: Lambda MicroVMs $0.1328, Cloud Run $0.079.

Raw results are on the local branch `spike/2691-s1-measure` under `spikes/2691-s1/results/`.
