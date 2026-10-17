# Chat execution-control continuity

A live Web Desktop check on the existing Private Preview reproduced the same
failure with native Codex and Claude: the first browser turn worked with the
owner's selected Full access mode, but the next turn fell back to Supervised.
The renderer preserved the saved model and omitted the submitted execution modes.

Use the latest admitted canonical run as the persisted source for that Chat's
interaction and permission choices. This is presentation of owner intent, never
a browser grant or authorization. Every new turn still passes current catalog,
account, permission and gateway admission checks.

- Derive controls once in contracts for all renderers. Select the latest run of
  this Chat; do not search backwards for a more permissive matching run. A changed
  model/account/options binding or ambiguous latest history restores no modes.
- Restore only choices supported by the current harness catalog. Existing Chats
  without accepted evidence use that harness's current defaults, independently
  of another Chat's global draft preferences.
- Fence unsent Web edits by runtime authority, Chat, model/options and admitted
  run. Electron fences local edits by connection identity, Chat and admitted run.
- Web Canvas, Web Desktop, Web Mobile, Electron Desktop and Native Mobile consume
  the same derivation. Native Mobile keeps its existing route/readiness checks.
- No endpoint, persistence migration, credential transfer or access-policy change.
  Owner Postgres canonical runs already store both modes. Existing transactions
  and admission authority remain unchanged; no new orphan/resource lifecycle.

## Acceptance

Regression tests must fail before implementation for draft-to-bound continuity,
foreign Chat isolation and native renderer restoration. Cover latest narrower
choices, failed admitted runs, changed account/model bindings, unsupported modes
and ambiguous ordering. Re-run the native Codex and Claude two-turn browser check
on an exact preview containing this fix before calling live continuity complete.
Keep local development servers and Electron closed under the owner's constraint;
Electron interaction validation remains pending until that constraint changes.

Work item: https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix
Stack: https://github.com/HamedMP/matrix-os/stacks/2621
