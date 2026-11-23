# Follow-up: one gateway Chat concurrency limit

Shared ticket: [ENG-540](https://linear.app/matrix-os/issue/ENG-540/perfchat-cut-codex-send-overhead-from-20-s-to-near-raw-codex).
Parent: [delivery batching PR #3607](https://github.com/HamedMP/matrix-os/pull/3607).

## Requested behavior

A personal VPS owner can admit up to 64 active canonical Chat runs. Remove the
separate eight-run owner quota and retain the overall 64-run admission ceiling.
Different ownership scopes share that same total. Overflow remains retryable;
this change does not add another gateway process or an overflow worker pool.

Raise the background supervisor's default from 32 to 64 live jobs to avoid an
earlier default ceiling for Codex. Idle retained runners still count as physical
jobs; machine resources and provider restrictions can impose lower availability.

## Authority and lifecycle

Preserve request principals, owner authorization, execution admission fences,
serialized background admission, existing resource isolation and cancellation.
Canonical records stay in owner Postgres; active admission stays in the gateway
orchestrator's existing registry. Do not change terminal or Zellij policy.

Direct sends, retries, native scheduled runs and both queue paths must reserve
from one global allowance before asynchronous admission/claim preparation.
Transfer the slot synchronously into active registration; release it when
admission, an empty claim or preparation ends without dispatch. Restart-idle
accounting remains separate from capacity so pending work is not counted twice.
Recovery must recognize reserved run IDs as live preparation, including personal
queued claims that have committed but have not registered an active dispatch.

Extraction plan: move slot accounting and personal queued dispatch into focused
helpers, preserving the orchestrator callback ports and database-backed
regressions as integration contracts.

## Acceptance and qualification

- Admit 64 held runs for one owner; reject the 65th with the existing busy error.
- Apply the same total across two owners and preserve execution fences.
- With 63 active runs, pause personal/shared queue preparation and reject a
  competing direct send; resume the queue into the 64th slot.
- Pause direct admission in the last slot; leave shared work queued. Verify
  failed shared preparation releases its slot for a subsequent direct send.
- Admit 64 mocked systemd jobs with the default supervisor; reject the 65th.
- Rerun the parent's ingestion/replay tests alongside the changed suites.
- Update the developer limits guide. Extend the companion public documentation
  work in site PR #370 during release qualification.
- Recommend Chat/runtime owner review. Unit and database-backed tests do not
  qualify 64 live provider processes or exact-build behavior on every client;
  those load and surface checks remain required before release readiness.
