# Main CI completion recovery

[ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks)

## Observed failures, 19 October 2026

- Stefan's `711a3d9` passed all hosted lanes in [CI 39281760842](https://github.com/HamedMP/matrix-os/actions/runs/39281760842). The [host-bundle gate](https://github.com/HamedMP/matrix-os/actions/runs/39281760737/job/118157408865) observed workflow success with stale job statuses and rejected `Unit Tests (4/4)` with an empty conclusion.
- The redundant [dedicated controller](https://github.com/HamedMP/matrix-os/actions/runs/39281764540) then rejected its already-completed requester as an admission failure. Its owned workload was cancelled, not qualified.
- Hamed's `d3d7aab` failed [dedicated qualification](https://github.com/HamedMP/matrix-os/actions/runs/39296256343). Retained lease `9919d939cec6d8d3fee55b1baf44212d` has benchmark exit 1: `bundled-icon-upgrade.test.ts` timed out comparing a 4 MiB Buffer in `retains an oversized selected image conservatively`. Production icon behavior was not implicated.
- Full local validation exposed the same recursive Buffer assertion in `tests/desktop/packaging.test.ts`: comparing decoded installer artwork took 74.4 seconds against a 30-second deadline. A direct decoded-byte comparison retained PNG-compression independence and the changed-pixel negative control, and the case then passed in 0.74 seconds under the same ongoing test load. No artwork changed.

## Acceptance and invariants

- Wait for a nonempty, terminal jobs inventory within the existing release deadline. Do not treat empty conclusions as failures or release evidence. Preserve terminal failure rejection and shadow policy.
- Authenticate source, configuration, run identity, attempt and newest requester before classifying completed-success delegated work as redundant. Revoke its owned lease and settle neutral, with no receipt/coverage credit. Failed or mismatched requesters remain rejected.
- Preserve the oversized-file and idempotent-upgrade assertions. Compare size and SHA256 instead of recursively comparing millions of Buffer elements. The isolated baseline took 7.6 seconds; the digest assertion took about 0.1 seconds in the focused validation.
- Preserve decoded installer-artwork dimensions and every pixel via `Buffer.equals`; retain the existing differently-compressed positive and changed-pixel negative controls.
- Exercise the actual release shell and controller workflow with simulated pending, timeout, failure, requester-completion and supersession cases. Retain lease/SSH/infrastructure negative controls.

## Activation

Review and merge the PR normally. The release workflow and icon test apply to new main runs. The lease helper requires green-main verification followed by the existing idle-host policy update and `MATRIX_CI_CONTROLLER_SHA` activation procedure. Do not mark historical failures successful or change routing flags. Validate a new main run and host-bundle gate after activation.

This internal CI repair changes no product UI or public API. Operator documentation is in `docs/dev/fast-ci.md`; public product documentation and surface captures are not applicable.
