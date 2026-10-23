# Canonical chat dispatch shutdown

[ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence) requires continuation cleanup to settle before its database is destroyed.

An active run leaves the control registry before its completion callback prepares queued work. Registry emptiness therefore does not establish quiescence. Track the complete dispatch and queue-promotion finalizer with a constant-space counter and a shared promise for the transition to zero. A chained queued dispatch participates in the same drain. Decrement in an outer `finally`, including closing and failed promotion paths.

This changes no endpoint, owner authority, queue admission, cancellation decision or timeout. Shutdown still stops admission through the existing closing boundary. `drain()` waits for already-started dispatch work; it does not permit new work or attest provider erasure.

The regression pauses queue preparation after the active registry becomes empty, proves drain remains pending, then releases preparation and requires drain to settle. Run on native PostgreSQL and the unit-test database implementation. Include the actual continuation suite in the required native Gmail inventory, retaining exact-file and zero-skip enforcement.

## Extraction plan

The existing orchestrator exceeds the entrypoint size target. Before adding another dispatch feature, extract the counter/shared-promise lifecycle into `chat/dispatch-lifecycle.ts` with begin, finish and drain operations. Move queued promotion coordination into a focused helper while leaving owner admission and control operations in the orchestrator. Preserve the paused-finalizer, chained-queue, closing and failed-promotion contracts during extraction; keep focused modules below500 lines. This bounded repair avoids combining that refactor with the reproduced shutdown race.

Public permission-flow documentation remains the existing ENG-355 [site PR287](https://github.com/FinnaAI/matrix-os-site/pull/287); this internal shutdown correction adds no product permission or API.
