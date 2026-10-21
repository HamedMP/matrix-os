# ENG-344: unified agent execution and waiting

Ticket: https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload

## Intent and correction

The requester approved the T3 approach, then explicitly clarified that fixing long-running failures is the core requirement. The earlier first pass only suspended work-idle during human waiting, distinguished timeout from Stop, and added Native Mobile attachment preflight. It left a managed ten-minute turn limit in place and therefore did not satisfy the original goal. This amendment supersedes that scope; the earlier commits and validation remain historical evidence only.

## Runtime contract

- An ordinary active turn is busy until terminal completion or cancellation, even when it emits no output. No default aggregate run deadline or progress-idle timer may terminate it. Session idle reclamation runs only when there are no active turns. Do not emit fake progress to keep a turn alive.
- Apply this user semantic across managed Matrix AI Chat, Recipe Bot and existing owner-backed Claude, Codex, Pi, OpenCode, Hermes and OpenClaw adapters. A model source and a coding harness are distinct. Keep source-specific credential/protocol requirements and explicit trusted timeboxes separate.
- Keep bounded preparation/startup, connection/header/control requests, individual inference/tool requests, human permission TTLs, output/parser buffers, model input/context budgets, credit/spending checks and OS isolation. A cancellable owned stream follows its run lifecycle rather than an ordinary one-shot request timeout. This is the explicit long-stream interpretation of the constitution’s external-call bounds.
- Do not make credentials permanent, extend paid admission, remove source revocation, increase monetary budgets or automatically replay an operation whose effects may already exist. The retired funded CLI contract may still provide an absolute credential deadline; that compatibility input must not be generalized to managed Pi.

## Managed Pi and Recipe Bot

Remove the ten-minute default aggregate deadline from managed Chat and Bot orchestration. Bound each setup operation independently at 60 seconds. Setup cancellation must settle without waiting for an uncooperative dependency; late runtime/start results must be cleaned rather than admitted after Stop.

An active execution binding has a renewable lease. The gateway renews every 30 seconds; each renewal attempt is bounded at 30 seconds and Stop drains it for at most one second. Recheck exact owner/chat/run/generation/root authority before and after asynchronous renewal. Registry renewal preserves the existing inference AbortController, cannot create a binding or revive revoked/expired state, and unbind precedes host Stop.

The supervisor owns a 900-second Pi execution lease with a 30-second sweep. It renews only existing unexpired Pi runtimes with the exact generation. Profile version 2 records the lifecycle change in its digest. Replace fixed systemd RuntimeMaxSec and nested worker/launcher/client/server aggregate timers with this lease and connection/caller cancellation. Keep all short control/connect bounds. The distinct restricted collaboration profile retains its 90-second workload lifetime.

Worker units use BindsTo and After for matrix-scope-runtime.service. The supervisor service has a 60-second systemd watchdog, serviced by a fixed notifier every 15 seconds after server startup; notifier execution is bounded at five seconds with at most one child. Workload units belong to other cgroups and cannot satisfy that watchdog. Keep CPU/memory/PID, filesystem, root, capability and broker-only network limits unchanged. Supervisor startup reconciles old Pi workers instead of assuming ownership. Failed cleanup keeps the runtime revoked and retries; no late worker reply may become a success after Stop or lease expiry.

## Other adapters

- Claude: remove default busy-turn 30-minute progress-idle. Preserve a 30-second first-valid-frame startup bound and 10-second stdin bound, explicit injected timeboxes, and separate human question expiry.
- Native Codex App Server: remove the whole-turn 24-hour and turn-no-progress cutoffs. Keep separately started tool/command bounds, human-wait handling, bounded event correlation and terminal-only idle hibernation. Legacy Codex must not retain its own default ten-minute child kill.
- Coding store, Pi and OpenCode: no nested default ten-minute aggregate deadline. Credential preparation remains bounded at 30 seconds. OpenCode response headers/control calls remain bounded; owned SSE and message completion follow run cancellation.
- Hermes: remove the default 30-minute turn timer. Preserve startup, individual RPC and interruption/cleanup bounds.
- OpenClaw: pinned official runtime 2026.7.1, commit 842a951d5d0843aa6eb77575dc9867bf0603835c, accepts timeout 0 as its no-run-timeout sentinel. Submit agent once, synchronously accept run identity, then observe that same run through bounded agent.wait requests. Wait timeout is not terminal and never resubmits agent. Retain bounded event buffering and best-effort remote abort on local Stop or an unconfirmed transport failure. Upstream timer-safe sentinel and upstream liveness are separate from Matrix’s policy.

## Waiting, cancellation and retry

A busy turn may wait for a person without consuming a session-idle deadline. Permission authority remains bounded independently: Claude questions default to 30 minutes; managed integration approvals retain ten minutes. Other provider policies remain adapter-specific. Multiple outstanding controls do not resume idle after the first response. Final resolution, expiry and close clean pending state and timers.

Approval submission rechecks expiry after asynchronous authority validation. At or after expiry it refuses and consumes the wait once, even if the timer callback has not run. It cannot execute a prepared mutation, deliver a late answer or authorize replay.

First cancellation cause wins. Explicit Stop must immediately settle local waiting even when a worker ignores cancellation. Bot durable state and canonical result remain cancelled if a late worker reports success. Cleanup, confirmed process exit and effects already produced are distinct; do not claim cancellation rolls them back. Resume/retry must revalidate current authority and input selection and must never automatically replay uncertain writes.

## Output and input

Cumulative display output and active-work lifetime are independent. Keep a bounded presentation, mark truncation once, and continue consuming control, state and terminal events. Per-frame/parser/queue limits protect memory and protocol integrity. Full raw-log archival, guaranteed lossless backpressure, document extraction and durable draft storage are separate deliverables; do not claim them from display truncation. The task result must inventory remaining adapter-specific cumulative limits and all preserved bounds precisely.

Native Mobile validates the current instance/model/options and attachment selection before upload or optimistic draft clearing, including retry. Invalid input remains editable/removable with safe copy; server ownership and actual-file admission remain authoritative. The approved attachment follow-up raises ordinary uploaded files to 10 MiB each and attachments to 20 MiB combined. Preserve eight attachments, four images, 2 MiB/image, the separate 8 MiB image total and default-funded aggregate image budget 1 MiB. Preserve image capability/type checks. Immutable submitted-file aliases may be read in hash-bound 32 KiB chunks; workspace/integration binary artifacts remain 1 MiB and whole-text reads remain 192 KiB. Generic upload limits, extraction and model context admission are separate contracts.

## Auth and resource matrix

| Boundary | Authority and validation | Public? | Bound/cleanup |
| --- | --- | --- | --- |
| Existing canonical Chat/Stop/control routes | Existing owner/chat/run access, strict canonical schemas, expiry recheck after awaits | No | Existing body/rate bounds and terminal cleanup |
| Internal runtime.renew | Gateway-owned supervisor Unix socket; strict runtime handle and exact execution generation; existing unexpired Pi profile only | No | 900-second renewable lease, bounded lanes/sockets, 30-second sweep |
| Managed binding renewal | Current owner/chat/run/generation/root and source authorization, checked around awaited host renewal | No | Capped registry, no replacement cancellation signal, Stop abort/drain |
| Bot worker command socket | Supervisor-owned relay to exact active runtime/generation; bounded single frame | No | Caller/connection/lease cancellation; short commands bounded |
| Per-inference broker | Existing owner/source/model/credit admission and cancellation, fresh credential resolution | No | Existing request, token, cost and concurrency bounds |
| Native attachment preflight | Advisory shared contracts; actual server admission remains source of truth | No new endpoint | Existing counts/bytes/types, safe failures preserve local edit state |

No new external HTTP endpoint, permission grant, database schema or credential export is introduced. Workers cannot call the supervisor renewal socket. All new maps, timers and subprocesses must be bounded and drained. Log error types server-side; expose only reviewed generic error copy.

## Verification and deliverables

1. RED on the prior implementation: a silent busy turn crosses each old ten/fifteen/thirty-minute or 24-hour threshold and fails. GREEN: the same turn stays busy, then completes or accepts Stop. Do not simulate ordinary provider progress during the gap.
2. Exercise real local Unix sockets through gateway client, supervisor controller, systemd launcher relay and worker command server with synthetic workers and fake time. Prove renewal across old deadlines, lost lease reclamation, stale generation/late completion rejection, connection cleanup and Stop headroom under bounded load.
3. Verify current authority revocation, funding/credit refusal, per-inference cancellation, renewal stalls, setup stalls, human expiry ordering, late worker success and terminal-only session reaping. Use small output thresholds/fixtures for truncation and protected controls.
4. Run affected gateway, coding, scope-runtime and deployment-contract tests plus configured typechecks after source settles. Do not rerun the unchanged 3,123 Native tests for this backend increment. Preserve the earlier Native TypeScript baseline of 63 existing errors in 15 files; never call the whole project green.
5. Independently review lifetime/authority/Stop/output boundaries and publish a Chinese limitation ledger with code versus live evidence, exact source and test provenance, remaining limits, cost/security tradeoffs and follow-up boundaries.
6. Update this spec, developer behavior documentation and applicable Trellis guardrails. Prepare the separate public documentation change in FinnaAI/matrix-os-site; it remains a separate constitution deliverable.
7. Reuse Draft PR2794 and the existing authorized Private Preview. Record exact new source/bundle/worker/Electron provenance before testing. The previous 05d466 short live successes cannot qualify this runtime correction. Preserve the user’s ordering: implementation and private acceptance, user review, then formal Greptile/CI. No production/shared Platform deploy or merge.

Applicable surfaces are Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Shared backend semantics do not establish live five-surface or Native device qualification. No source policy may depend on one renderer.
