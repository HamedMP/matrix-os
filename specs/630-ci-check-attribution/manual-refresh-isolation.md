# Keep PR refresh validation on its isolated execution commit

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240).

## Observed failure

[Router 39409662795](https://github.com/HamedMP/matrix-os/actions/runs/39409662795)
ran on Main `ba183d5` for PR #2781. Its advertised merge `0165f0c` had
second parent `1a04b63`, while the current PR head was `4a4e748`. Rejecting
that source was correct, but the router performed the rejection on Main before
dispatching isolated execution, making Main red for another PR's source.

## Behavior and boundaries

- Main validates bounded input syntax, execution mode, PR repository/number,
  and cheap closed/draft/changed-head/changed-stack-base fences. It verifies
  the protected execution ref's exact parent, tree and Main ancestry before
  forwarding the unchanged head/base/source tuple and execution mode.
- The isolated CI workflow still authenticates its execution origin, then calls
  `resolveRequestingSource` before candidate checkout or workload admission.
  Merge parents, live PR identity, Linux labels, source freshness and native
  stack proof remain mandatory there. Invalid source still fails qualification.
- Main routing success grants no coverage or receipt. The aggregate and source
  qualification gates continue to require the actual candidate checks. No
  failure is deleted, rewritten as success, or accepted through a permissive
  fallback. Hosted-only requests preserve their existing full hosted policy.

## Validation and activation

Tests first reproduce the Main failure with both Linux and hosted-only requests.
The same real source resolver must still reject the forwarded bad merge after
the repair. Positive controls preserve exact source parents; negative controls
retain label admission, input/repository checks and protected execution proof.
Existing router, source resolver, routing and isolated handoff tests remain.

This helper is loaded from `MATRIX_CI_CONTROLLER_SHA`. Merge alone does not
activate it: obtain full green Main qualification, create/verify its protected
tree-identical execution child, follow the existing idle-host approval procedure,
then advance the reviewed pin. Preserve current image/harness pins and all checks.
Verify an invalid PR merge fails only in isolated execution and a valid refresh
completes real candidate qualification. Historical failures remain evidence.

The separate Main Linux failure in controller `39408734904` occurred before a
test receipt, during cancellation/cleanup of the predecessor's container. It
requires genuine fresh Main qualification and host cleanup investigation; this
router change does not convert that failure into infrastructure fallback.

This changes internal CI orchestration only, with no product UI or public API.
Product screenshots and a public product documentation PR are not applicable.
