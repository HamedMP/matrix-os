# Priority Linux CI rollout

Ticket: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-opt-in-queued-linux-ci-and-native-typescript-checks)

## Goal

Ship the reviewed CI optimization stack with `fast-ci` opt-in for priority PRs and private Linux execution for main pushes when routing is enabled. Preserve full qualification coverage and truthful results for ordinary PRs, native stacks and exact main revisions.

## Requirements

- R1: Preserve the existing review layers, integrate current main, and retain native TypeScript checks, production Web and Electron builds, full unit tests, sync and SDK compatibility checks, and required Linux browser coverage.
- R2: Admit open, non-draft, same-repository PRs carrying both `fast-ci` and current-head `ready-for-ci`. The old `ci-linux` label does not opt a PR in. When `MATRIX_CI_DEDICATED_ENABLED` is enabled, eligible main pushes use private Linux by default without PR labels. Forks, unsupported events and retained hosted-only security/platform lanes keep hosted coverage.
- R3: Serialize full Linux workloads. Main has queue priority, with at most two consecutive admitted main workloads before the oldest waiting PR; order is FIFO within each class. Priority never preempts an active owner. Preserve other PRs when a new head supersedes one PR's queued or running work. Queue waits are bounded at 1800 seconds, with bounded registry capacity.
- R4: After the host lock is acquired, authenticate and revalidate exact PR head/base/ordered merge parents or exact current main commit and its public parents, requesting run/attempt, reviewed default-branch controller, immutable image/harness and resource limits before starting candidate CPU.
- R5: Cancellation, connection loss, expiry and source drift terminate only the owned workload. Prove container removal and release the host lock before another workload starts. Keep credentials outside candidate execution.
- R6: Parent-only changes invalidate completed child qualification. Required merge gates must reject stale source tuples; a non-required red check is insufficient. Require `CI Source Qualification` from a separate checks-only GitHub App, pinned by required-check `integration_id`. Shared Actions credentials cannot publish or adopt this gate. Ordinary never-admitted hosted PRs receive explicit not-admitted success. Preserve genuine Actions-owned `CI Results` checks. A trusted main-only dispatch refreshes the same child head against a changed parent; its complete hosted and dedicated evidence can restore only the distinct freshness context. A failed original CI Results check still blocks merge.
- R7: Run shadow canaries with hosted gates retained: ordinary PR, stacked child with a non-main base, new-head supersession, parent-only update, queued cancellation and rollback. Record exact provenance, queue/setup/execution timings, full reports and cleanup.
- R8: Activate only after current-head review, required CI and canaries pass. Keep the explicit repository switch disabled until acceptance; PR admission also requires both labels, while main pushes use the enabled default route. Removing eligibility or disabling the switch after prior admission keeps the gate blocked until a fresh main-only hosted refresh proves complete hosted coverage. A previous delegated PR run cannot restore it, even when the source tuple is unchanged.
- R8a: Main pushes delegate to Linux only when `MATRIX_CI_DEDICATED_MAIN=true` as well as `MATRIX_CI_DEDICATED_ENABLED=true`. Otherwise main stays on full hosted CI with shadow Linux observation, and its `CI Source Qualification` gate runs in shadow mode. This lets PR routing ship while main-push controller admission is fixed separately. Rollout order: advance `MATRIX_CI_CONTROLLER_SHA` to a commit containing this split before setting `ENABLED=true`, because older pinned gates expect delegated main evidence. Keep `MATRIX_CI_DEDICATED_SHADOW=true` while `MAIN` is unset so main shadow leases stay admissible.

- R9: Infrastructure fallback may select complete hosted execution only after a recognized pre-workload availability failure, authenticated proof of no workload and owned cleanup, and fresh exact-source/run validation. Supported root outcomes cover queue capacity/deadline, host capacity, image or daemon availability; an unreachable daemon with unproved cleanup stays red. The narrow controller transport exception accepts only a known pinned-endpoint timeout/refusal before any control bytes or grant, within the 20-second handshake bound, followed by fresh API validation. Generic SSH/authentication/host-key errors, unknown or mid-run failures, failed workloads/evidence, stale source, cancellation and uncertain cleanup remain red. Every hosted lane and the independent App coverage inventory must pass for that exact requesting attempt; fallback never adopts an old green run.

## Implementation Units

### U1. Source integration

Rebase the existing 28-layer native stack in an isolated manual worktree. Preserve original worktrees and private benchmark evidence. Reconcile workflows, package scripts, frozen dependency graph and test aliases with current main; retain the brand build prerequisite.

### U2. Trusted lease runtime

Implement bounded owned leases, an authenticated controller handshake after the host lock, renewals and cancellation. Move the proven isolated qualification into reviewed reusable modules. Test the real process/lock lifecycle and complete evidence validation.

### U3. Priority controller and gate binding

Implement `fast-ci` plus reviewed-head admission, main-push routing, fair main-priority dispatch, shadow mode, after-lock live API validation, parent reconciliation and narrowly proved complete hosted fallback. Bind successful results to the exact current requester and source tuple. Test actual API response shapes and merge-gate enforcement.

### U4. Qualification and shipping

Run focused contracts, required static checks and full qualification on the final source. Publish reviewable layers with this ticket and evidence. Land reviewed heads, configure protected controller/image pins, run ordinary/stacked/main live canaries, test priority fairness, both approved fallback paths and rollback, then enable routing.

### U5. Engineering handbook

Publish a separate `FinnaAI/matrix-os-site` handbook follow-up to merged PR #224, linked to ENG-240, with the public-safe engineer workflow: `fast-ci`, current-head review, main priority/fairness, exact-source results, narrow full-hosted fallback and rollback. Keep it in the engineering handbook, as requested. Private host identities, credentials and operator commands remain outside the public repository.

## Authentication and wiring

| Boundary | Authority | Public access |
| --- | --- | --- |
| GitHub priority request | Default-branch controller and authenticated live PR/run APIs | No privileged candidate workflow |
| Host lease run/grant/renew/cancel | Dedicated SSH key, forced dispatcher, exact request and private owner capability | No shell, forwarding or arbitrary command |
| Candidate qualification | Isolated UID 10001, pinned image, fixed resource limits, no host credentials | Public source checkout only |
| Qualification result | Trusted host validator and default-branch controller; exact current request/source tuple | Sanitized check output only |
| Required freshness gate | Checks-only GitHub App; main-only protected environment key and pinned App ID | No candidate or host credential access |

The protected `MATRIX_CI_CONTROLLER_SHA` pins reviewed executable controller code independently of the current default-branch run definition SHA; ordinary main advances do not require expanding the host allowlist. Admission and renewal recheck the protected pin and its ancestry against current main. The host queue selects main-priority or oldest-PR work with a two-main fairness bound; the controller opens the forced SSH session, revalidates after the host-lock challenge, and grants or cancels that owned lease. The host validates the fixed envelope, runs the pinned qualification, independently checks complete evidence and cleanup, and returns a bound receipt. The requesting CI gate revalidates the receipt against current GitHub state before success. Integration tests cover this whole chain, including cancellation and parent-only source changes.

Native GitHub stacks may use the adjacent predecessor's synthetic merge as the actual first parent. `baseSha` remains the live direct branch SHA; signed `mergeParents` records the exact public commit pair. A protected controller accepts this difference only after checking the official open stack's complete ordered membership (at most 100 PRs), exact adjacent same-repository current PR/ref/merge, and tree equality between that merge and the direct branch base, and between the child merge and head. It rereads both PRs, membership, trunk and parent reference before accepting. Unsupported APIs, incomplete membership, source drift or non-equivalent trees fail closed. The proof has a 20-second total deadline and 10-second individual API bounds and runs at admission, after host lock, each renewal and final result/freshness verification. The immutable host preparer independently verifies the signed actual public parent pair; it does not authorize native membership itself.

The initial grant expires after 30 seconds. Renewals verify live state every 60 seconds and expire after 120 seconds; source drift detection is bounded at 60 seconds, while connection loss and authenticated cancellation stop the owned workload immediately. First admission and final settlement use unconditional API reads. Execution controllers carry an immutable `dedicated-refresh-v2 execution=true` marker only for initial ordinary CI in-progress events, main refresh requested events and refresh rerun in-progress events. Completed or first-attempt refresh in-progress reconciliation runs carry `execution=false` and cannot supersede a lease or replace completed execution evidence. Authenticated conditional responses require exact bounded cached proof; API errors or a requested polling interval above 60 seconds fail closed. Ordinary unadmitted PRs receive the distinct N/A gate before execution pins exist; admitted execution requires every reviewed pin.

`MATRIX_CI_GATE_APP_ID` identifies the gate issuer. Its private key lives only in the main-restricted `matrix-ci` environment as `MATRIX_CI_GATE_APP_PRIVATE_KEY`; installation tokens grant checks write access for this repository only and are revoked after the job. The normal Actions token handles bounded source/run reads and dispatches separately. Hosted rollback accepts only an authenticated `hosted-refresh-v1` default-main workflow dispatch and verifies its genuine CI Results job, run, and check provenance before clearing the gate.

Before candidate execution, immutable preparation derives all tracked file paths, blob hashes, modes and sizes from the pinned tree. The manifest is limited to 2 MiB, 30,000 paths, 50 MiB per tracked file and 512 MiB in total. Each source guard checks actual bytes and modes independently of mutable Git index/ignore flags. Four additional host-triggered final probes check all worktrees; candidate artifacts cannot replace these probes. These are boundary snapshots, not proof against fabricated tests or transient source changes between snapshots.

## Risks and acceptance

Routing remains disabled. The checks-only GitHub App setup is complete, and focused local contracts pass; current-head reviews, required hosted CI and live ordinary/stacked/main canaries remain pending. Local tests do not prove activation or live fallback.

The single server limits concurrent full qualifications; queue wait is reported separately. The latest completed manual qualification of source `b1e48363b836d513e03352e1cdf302f79bab2eeb` took 685 and 684 seconds (11 min 25 s and 11 min 24 s) in two fresh containers using the same prepared immutable image. It retained all tests, 55 phases, 14 source guards and four independent host checks. These measurements precede the `fast-ci`, main-priority and fallback changes and do not qualify their live integration or measure complete hybrid GitHub CI. Five minutes remains unmet. No coverage is removed to shorten the result.

Race risks are stale merge refs, old requesting runs, parent-only updates and cancellation while another workload owns the server. Acceptance requires real queue/cancellation and source-binding evidence. A failed or missing phase/report, unresolved cleanup, or stale tuple never produces a passing qualification.

Execution has a 30-minute deadline. An uncertain controller/host crash blocks subsequent admission and requires operator recovery after owned cleanup is proved. Independent host cleanup bounds crash-orphan containers to 50 minutes plus bounded removal; the image keepalive is not an adversarial watchdog. Parent reconciliation is periodic and API operations are not atomic; permission/API outages can prevent replacing an existing success. Live merge-block and parent-refresh canaries must establish the actual enforcement boundary before activation.

Stakeholder review of this spec is recommended. Hamed has authorized implementation and shipping; review and CI remain the rollout gates.

Operational owner: Hamed. Initial observation window: first ten routed PR/main runs, recording queue time, runtime, cancellation and fallback outcomes. Disable routing immediately for an incorrect green result, leaked capability, orphan workload or lost coverage; retain hosted gates during investigation.
