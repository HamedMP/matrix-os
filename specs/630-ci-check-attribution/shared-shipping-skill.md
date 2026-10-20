# Shared engineering shipping skill

Tracking: [ENG-349](https://linear.app/matrix-os/issue/ENG-349).
Related CI infrastructure: [ENG-240](https://linear.app/matrix-os/issue/ENG-240).

Give engineers a reusable `matrix-ship` entry point for PR qualification,
preview requests, CI diagnosis and authorized shipping on Matrix infrastructure.
Keep `skills/matrix/ship` canonical, with the existing synchronizer and both
installer manifests distributing it to Matrix, Codex, Claude Code, Agent and
Hermes. Include a concise qualification reference and Codex discovery metadata.

Use current repository procedures rather than copying controller code. The
skill must distinguish exact-source tests from draft/routing-only runs, separate
merged and activated helpers, preserve existing checks and peer approval, and
respect the current engineer's scoped authorization. It must discover deployed
preview capabilities before selecting labels or promising artifacts/capacity.
It must preserve the Matrix test admission/resource boundaries and gateway.

Validation: a real sync/discovery regression copies the shipped skill and
resources into disposable homes for every supported target and loads the synced
skill through the actual kernel loader. Retain existing ownership/collision and
installer parity tests. Validate Codex skill metadata, shell syntax and relevant
skill loader tests. Update internal engineering install/usage pages.

## Audit-driven coordination changes

The October 20 engineering audit identifies contradictory shipping instructions
and repeated qualification as the immediate coordination problem. Add one
read-only `scripts/review/pr-readiness.mjs <pr>` report, called by `matrix-ship`,
push, land and both monitor entry points. Reuse the existing review carry-over
verifier. Report a frozen head/base, draft state, review validity, unresolved
threads, independent approval, required check links and the next action.
Paginate review data, reject head/base changes during collection and fail closed
on inaccessible or malformed data. It must never label a PR merge-ready: genuine
qualification artifacts, finding dispositions, ticket verification, applicable
surface evidence and merge authorization still require verification.

Keep draft status separate from review requests: explicitly request review on
drafts and report reviewer unavailability rather than alternating ready/draft to
force execution. Reuse evidence only when its source, inputs, command, toolchain
and policy remain valid; this report neither grants test credit nor skips checks.
Test each stack layer on its actual base and the assembled behavior at its tip.

Follow-ups under ENG-349, in execution order (engineering owner review requested):

| Deliverable | Acceptance |
| --- | --- |
| Scanner and assurance inventory | Identical prohibited TS/TSX patterns fail across shell/desktop/mobile; every required DB test is collected; advisory audits and measured coverage are named accurately. |
| Active outcome triage | Each active outcome is ship-next, blocked, superseded or parked, with an owner, dependencies and one next action. Historical audit counts remain dated snapshots. |
| Shared lifecycle contracts | Representative composed journeys test concurrent intent, authority changes before execution/commit, cancellation, partial success and restart recovery. |
| Validation reuse and routing | Compare identical sources on hosted/dedicated CI; measure queue/setup/execution/orchestration separately; reduce redundant runs while retaining full Main qualification. |
| Trusted Review Policy enforcement | Reuse carry-over in protected trusted execution, prove stale-review/thread handling, then separately review ruleset activation and emergency bypass procedure. No settings change in this PR. |
| Deployment outcomes | Connect existing release/canary records to time-to-verified-deployment, rollback and recovery measures; do not equate merged layers with deliveries. |
| Instruction hierarchy | Reduce root instructions to universal constraints and routing; separate security/correctness requirements, automated gates and review heuristics, with reviewed policy amendments for any changed requirement. |

Do not bundle scanner/runtime changes or constitution amendments into the skill
rollout. Validate readiness races, pagination, stale approvals and green draft
no-op statuses with meaningful regressions. Public documentation deliverable:
review applicability with the site owner after internal rollout; no customer
runtime, API or UI behavior changes here.

This is internal engineer tooling, with no new runtime API or renderer change;
product captures and public product documentation are not applicable. Request
engineering owner review of the reusable authorization and qualification
instructions. Publishing this skill does not deploy the unfinished unified
preview stack, provision slots, activate a controller or grant admin bypass.

## Qualification repair: Chat catalog discovery

Full CI exposed a composed-path mismatch: the kernel accepts the canonical
Codex-format skill, but the Chat recipe catalog required legacy top-level
`author` and silently omitted `matrix-ship`. Support exact `Matrix OS` authorship
in the standard `metadata.author` field as well as the existing top-level field.
When both are declared, both must agree. Keep trusted bundled roots, regular-file
checks, link containment, instruction limits and owner-skill rules unchanged.
Use one kernel-owned extension reader shared by kernel discovery and Chat,
reusing the already-pinned YAML decoder with a 28 KiB header bound, no aliases
and no duplicate/multiple documents. Preserve legacy skill identity/body parsing
and legacy trigger precedence. Store shipping triggers as a comma-separated
`metadata.triggers` string, keeping standard skill frontmatter compatible.
Keep the every-shipped-skill trigger/link invariant by checking resolved trigger
metadata, and strengthen the landing command guard to require the frozen head
while retaining its ban on custom squash subjects.

Acceptance: the actual canonical skill appears in the Chat catalog, resolves its
real body/source/hash, and revalidates; malformed, foreign and conflicting author
declarations remain unavailable. Preserve the existing all-shipped-skills test.
This changes discovery compatibility on the existing backend contract, adding no
endpoint, permission or renderer. Public product documentation remains deferred
as requested; internal skill guidance is already included. Full PR CI reruns on
the repaired head after fresh review; the failed earlier run remains evidence.
