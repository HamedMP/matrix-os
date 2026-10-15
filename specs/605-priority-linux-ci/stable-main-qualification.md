# Preserve CI when main advances

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240).

## Approved policy

A PR targeting `main` keeps coverage for its unchanged head and the immutable
merge source actually tested. Advancing main alone does not revoke an active
lease, discard a successful receipt, dispatch replacement coverage or require
another branch update. This accepts the integration risk of loose GitHub checks:
two independently green PRs can interact badly when merged. Keep full main CI;
stop further merges and repair or revert if it fails.

- Preserve required `CI Results`, its GitHub Actions issuer, Greptile 5/5 and
  one approving peer review. New pushes still dismiss approvals and run CI.
- Verify the tested merge's exact ordered parents `[recordedMain, currentHead]`
  and that recorded main is an ancestor of live main. Do not rewrite a receipt
  to claim it tested a newer main revision.
- Reject changed heads, target refs, repositories, admission labels, closed or
  draft PRs, rewritten main history, cancelled/superseded attempts and missing,
  failed or unauthenticated coverage. Do not fall back past a newer failed or
  pending same-head request, including one against another main base.
- Keep non-main stack parents strictly current, including the existing bounded
  native stack-membership/tree-equivalence proof. Main-push qualification still
  covers its exact pushed source. Keep routing flags, image, harness, resource
  limits, cleanup, independent hosted lanes and credential boundaries unchanged.

## Implementation and verification

The shared main-PR helper discovers the newest genuine requesting run for the
current PR head. Run titles identify candidate sources; they do not authenticate
historical merges. The existing protected App gate records a bounded provenance
journal only from the live canonical GitHub merge or the actual trusted PR event.
Historical coverage must match that independently authenticated journal, its
ordered merge parents and main ancestry. No new workflow, job, flag or required
check is introduced. The reviewed helper pins the existing public App ID `5271502`;
its private key stays in the main-only `matrix-ci` environment. Admission uses the event
snapshot; grants, renewals, result verification, metadata checks and source-gate
reconciliation share the same source policy. A main-only update keeps the old
base/source in the receipt and gate summary. Retargeting and a new PR head do not.

Tests first reproduce main moving before admission and during execution. An
integration test uses real internal helpers through admission, post-lock grant,
renewal, immutable archive validation, backend settlement, protected source gate,
legacy reconciliation and metadata reuse; only GitHub/host transport boundaries
are fixtures. Negative cases cover rewrites, invalid parents, new/failed/pending
requests, altered admission and strict stack parents. Existing full CI/harness
contracts remain required. Tests also reject arbitrary merge trees advertised in
PR-owned titles, foreign App/controller provenance and recovery races. Local
fixtures are not a live activation claim.

Historical admission and pre-dispatch verification may wait up to 60 seconds for
concurrent protected journal publication, before the short SSH grant deadline.
The journal keeps at most four sources for a head; missing provenance, capacity
exhaustion for a historical source, API denial or a lost concurrent journal update
fails closed. A currently canonical source remains eligible without historical
attestation. Rollout must exercise publication and renewal under real load;
preserve and diagnose failed attempts rather than bypassing these checks.

## Coordinated rollout

1. Keep `strict_required_status_checks_policy=true` while this PR is reviewed.
   Require current-head Greptile 5/5, green full CI and peer approval before landing.
2. After merge, qualify full main CI and activate the reviewed controller pin
   through the existing trusted, idle-host policy procedure. Candidate-owned CI
   consumers must contain this change too; older PRs may need one final main update.
   A merge alone does not update the privileged pinned controller. Missing trusted
   SSH host identity blocks activation; never bypass host-key checking.
3. Verify a genuine full Linux PR run and its independent hosted checks while
   main advances: no cancellation/restart, no automatic main-only replacement,
   original tested base/source retained, genuine required aggregate green. Also
   verify a changed head/stack parent invalidates correctly. Retain failed attempts.
4. Only after reviewed helpers are active and these checks are green, change
   **only** ruleset `12881269`'s `strict_required_status_checks_policy` to `false`.
   Preserve the full ruleset, `CI Results` integration `15368`, and approval
   ruleset `25072894` unchanged. Snapshot and compare all rules/variables before
   and after; verify the only setting difference is this boolean.
5. Verify an unchanged, approved green PR remains mergeable after another main
   advance, and a failed current-head CI still blocks it. Observe the first ten
   merges. Watch requesting runs per unchanged head, queue time and main CI failures.

Rollback: restore that single freshness boolean to `true` first, then investigate
or restore the previous reviewed helper pin using the same guarded procedure.
Never weaken CI, review, approval, immutable-source or host-cleanup checks.

Owner: Hamed / this CI repair chat. Contributor instructions live in
[`docs/dev/fast-ci.md`](../../docs/dev/fast-ci.md). The separate engineering
handbook follow-up in `FinnaAI/matrix-os-site` remains the existing U5 deliverable;
its copy must describe the activated policy rather than promise an unperformed cutover.
