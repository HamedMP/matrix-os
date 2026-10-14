# Terminal activity timestamps

## Problem and evidence

Hamed reported that nearly every unused terminal showed "2 mins ago" in the Terminal list ([Slack source](https://matrixos.slack.com/archives/C0C3ZFXQ83W/p1791983387084899)). The user subsequently added the `handoff-skill` rename failure to the same bugfix scope ([rename evidence](https://matrixos.slack.com/archives/C0C459830FJ/p1791985287358939)). Grouping, ordering and search remain a separate UI change.

At main `0348437bc120a37d861904fa7969066e8bbe9222`, Desktop renders `TerminalTab.updatedAt`. `TerminalRuntime.restoreAll()` reconciles every live tab through `activateTab()`, which advances that field regardless of activity. Initial observer frames and unchanged checkpoints also advance it. UI bookkeeping uses the same field. Read-only list polling and viewer heartbeats themselves do not write activity.

## Intended behavior

- Optional `activityAt` is owner-local durable terminal activity, distinct from metadata `updatedAt`.
- New tabs start at creation; successful input and changed, non-initial output advance activity.
- Restore, observer initial replay, identical output, snapshot import, heartbeat, canonical-size bookkeeping and UI metadata do not advance activity. A subsequent screen redraw that changes content counts as output.
- Legacy/migrated records with no trustworthy activity timestamp remain unknown until new input/output. Do not infer activity from an already polluted `updatedAt`.
- Desktop shows `activityAt` with a tooltip explaining input/output semantics. Background command output counts as activity even if the user has not opened that tab.

## Regression scenarios

| Case | Action | Expected result |
| --- | --- | --- |
| Idle restart | Restore a live tab after advancing the clock | Activity unchanged |
| Observer reconnect | Receive an initial frame, including a changed presentation | Activity unchanged |
| Duplicate output | Checkpoint identical ANSI, viewport and scrollback | Activity unchanged |
| Real output | Change ANSI, viewport or scrollback | Activity advances and survives store restart |
| Input | Deliver viewer input or direct CLI/API input | Activity advances only after success |
| Rejected input | Fail the actual pane write | Activity unchanged |
| Persistence failure | Deliver input, then fail activity bookkeeping | Input acknowledged; no invitation to replay the command |
| Read/heartbeat | Poll workspaces and touch a viewer | Activity unchanged |
| UI bookkeeping | Save pin/read state and reconcile runtime IDs | Metadata can advance, activity unchanged |
| Historical import | Import a retained snapshot | Import is not fresh activity |
| Legacy | Read an old record without `activityAt` | "Activity unknown" until real activity |
| Desktop refresh | Refresh a tab with recent metadata but old activity | Show the old activity, not the sync time |

## Invariants and implementation boundary

The owner-local `terminal-workspaces.json` remains canonical. Activity updates use the existing serialized, atomic store mutation path. Input stays in its existing per-tab queue; bookkeeping failure is logged after successful delivery rather than turning it into a failed command. No auth, endpoint, secret or control policy changes. No new timers or registries.

Output classification is extracted into `terminal-activity.ts`. The large runtime entrypoint receives only the observer flag and one queue completion hook; broader runtime/contract refactoring is deferred to avoid changing unrelated behavior.

## Rename defect and repair

The screenshot shows a valid `handoff-skill` label and `Could not rename shell`. Local source reproductions establish two independent defects: output/checkpoint revisions reject an otherwise unchanged display name, and runtime rename changes the Zellij internal discovery name before the metadata compare-and-swap. After that side effect, restoration cannot discover the original tab; a failed CAS can therefore still damage runtime identity.

Rename now atomically changes durable display metadata only. It preserves the physical tab name, stable ref, incarnation, process and I/O. New Desktop, Web and Mobile callers send optional `expectedName`; the store compares that field under its existing write serialization and rejects an actual competing rename or future revision. Older callers keep the full-revision guard. HTTP and owner-only socket schemas validate/forward the same precondition. Staged/exited metadata can be renamed without a live Zellij command. Existing owner and project admission remain unchanged.

The upstream 0.44.3 CLI supports `rename-tab --tab-id`; parameter mismatch is excluded ([version-pinned CLI source](https://raw.githubusercontent.com/zellij-org/zellij/v0.44.3/zellij-utils/src/cli.rs)). These are source/runtime reproductions; no read of Hamed's Main or claim about its exact network error status was made.

Tests cover rename after output, persisted label after restart, continued process input, no identity mutation on conflict, legacy strict revision guards, future revision rejection, retained exited metadata, HTTP→socket precondition forwarding, and unchanged owner-denial behavior. The bugfix does not create, terminate or recreate any customer process.

## Qualification and delivery

Local component screenshots use actual main/fixed Sidebar components with real store-generated fixture data. They are regression evidence, not a customer deployment or Electron qualification. The original private Slack screenshot remains outside the repository.

| Surface | Scope / evidence status |
| --- | --- |
| Electron Desktop | Affected list UI; component regression passes. Real Electron screenshot/recording pending with sole GUI executor. |
| Web Desktop / Web Canvas | Runtime contract carries the optional field; no activity list rendering changed. Formal surface validation pending. |
| Web Mobile / Native Mobile | Optional contract field is additive; no UI changed. Formal recovery validation pending. |

Linear searches found no exact matching timestamp issue; ticket confirmation is pending before publication. ENG-294 concerns frozen output after reattachment and is not reused. Stakeholder review of the timestamp semantics is recommended. Public documentation adds no feature in this repair; the semantics and test cases are recorded here for review.

Publication/merge gates remain: verified Linear ticket; current-head Greptile 5/5; `fast-ci` before `ready-for-ci`; real `CI Results` green on the exact head; no unresolved review threads; independent approving review; branch up to date with main. No Slack messages, Main updates or deployments are authorized by this task.
