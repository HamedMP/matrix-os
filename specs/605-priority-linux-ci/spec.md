# Priority Linux CI rollout

Ticket: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-opt-in-queued-linux-ci-and-native-typescript-checks)

## Goal

Ship the reviewed CI optimization stack and allow engineers to opt priority PRs into the existing Linux server. Preserve full qualification coverage and truthful results for ordinary and stacked PRs.

## Requirements

- R1: Preserve the existing review layers, integrate current main, and retain native TypeScript checks, production Web and Electron builds, full unit tests, sync and SDK compatibility checks, and required Linux browser coverage.
- R2: Admit only open, non-draft, same-repository PRs carrying both `ci-linux` and `ready-for-ci`. Main pushes, forks and retained hosted-only security/platform lanes stay on hosted CI.
- R3: Serialize full Linux workloads. Preserve other PRs when a new head supersedes one PR's queued or running work. Bound queue capacity and waiting time.
- R4: After the host lock is acquired, authenticate and revalidate exact PR head, base reference/SHA, ordered merge parents, requesting run/attempt, reviewed default-branch controller, immutable image/harness and resource limits before starting candidate CPU.
- R5: Cancellation, connection loss, expiry and source drift terminate only the owned workload. Prove container removal and release the host lock before another workload starts. Keep credentials outside candidate execution.
- R6: Parent-only changes invalidate completed child qualification. Required merge gates must reject stale source tuples; a non-required red check is insufficient. Always require a distinct default-controller `CI Source Qualification` context, with explicit not-admitted success for ordinary hosted PRs. Preserve genuine Actions-owned `CI Results` checks. A trusted main-only dispatch refreshes the same child head against a changed parent; its complete hosted and dedicated evidence can restore only the distinct freshness context. A failed original CI Results check still blocks merge.
- R7: Run shadow canaries with hosted gates retained: ordinary PR, stacked child with a non-main base, new-head supersession, parent-only update, queued cancellation and rollback. Record exact provenance, queue/setup/execution timings, full reports and cleanup.
- R8: Activate only after current-head review, required CI and canaries pass. Require both labels and an explicit repository switch; removing eligibility or disabling the switch restores hosted coverage.

## Implementation Units

### U1. Source integration

Rebase the existing 28-layer native stack in an isolated manual worktree. Preserve original worktrees and private benchmark evidence. Reconcile workflows, package scripts, frozen dependency graph and test aliases with current main; retain the brand build prerequisite.

### U2. Trusted lease runtime

Implement bounded owned leases, an authenticated controller handshake after the host lock, renewals and cancellation. Move the proven isolated qualification into reviewed reusable modules. Test the real process/lock lifecycle and complete evidence validation.

### U3. Priority controller and gate binding

Implement dual-label routing, shadow mode, FIFO dispatch, after-lock live API validation and parent reconciliation. Bind successful results to the exact current requester and source tuple. Test actual API response shapes and merge-gate enforcement.

### U4. Qualification and shipping

Run focused contracts, required static checks and full qualification on the final source. Publish reviewable layers with this ticket and evidence. Land reviewed heads, configure protected controller/image pins, run both live canaries, test rollback and enable opt-in routing.

### U5. Engineering handbook

Update the separate `FinnaAI/matrix-os-site` documentation PR #224 with the public-safe engineer workflow: labels, queue expectations, exact-source results, retained hosted coverage and rollback. Keep it in the engineering handbook, as requested. Private host identities, credentials and operator commands remain outside the public repository.

## Authentication and wiring

| Boundary | Authority | Public access |
| --- | --- | --- |
| GitHub priority request | Default-branch controller and authenticated live PR/run APIs | No privileged candidate workflow |
| Host lease run/grant/renew/cancel | Dedicated SSH key, forced dispatcher, exact request and private owner capability | No shell, forwarding or arbitrary command |
| Candidate qualification | Isolated UID 10001, pinned image, fixed resource limits, no host credentials | Public source checkout only |
| Qualification result | Trusted host validator and default-branch controller; exact current request/source tuple | Sanitized check output only |

The protected `MATRIX_CI_CONTROLLER_SHA` pins reviewed executable controller code independently of the current default-branch run definition SHA; ordinary main advances do not require expanding the host allowlist. Admission and renewal recheck the protected pin and its ancestry against current main. The controller queues work, opens the forced SSH session, revalidates after the host-lock challenge, and grants or cancels that owned lease. The host validates the fixed envelope, runs the pinned qualification, independently checks complete evidence and cleanup, and returns a bound receipt. The requesting CI gate revalidates the receipt against current GitHub state before success. Integration tests cover this whole chain, including cancellation and parent-only source changes.

## Risks and acceptance

The single server limits concurrent full qualifications; queue wait is reported separately. The measured complete Linux workload is currently about eleven minutes, and five minutes remains a target rather than an achieved result. No coverage is removed to shorten the result.

Race risks are stale merge refs, old requesting runs, parent-only updates and cancellation while another workload owns the server. Acceptance requires real queue/cancellation and source-binding evidence. A failed or missing phase/report, unresolved cleanup, or stale tuple never produces a passing qualification.

Stakeholder review of this spec is recommended. Hamed has authorized implementation and shipping; review and CI remain the rollout gates.

Operational owner: Hamed. Initial observation window: first ten opted-in runs, recording queue time, runtime, cancellation and fallback outcomes. Disable routing immediately for an incorrect green result, leaked capability, orphan workload or lost coverage; retain hosted gates during investigation.
