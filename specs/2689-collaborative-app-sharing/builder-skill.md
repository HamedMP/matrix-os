# Collaborative app builder follow-up

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29). Builds on merged
[#3154](https://github.com/HamedMP/matrix-os/pull/3154) and [spec.md](spec.md).

## Approved outcome

Ship `matrix-collaborative-app-builder` alongside the ordinary builder. Support new
apps and conversion without resetting existing data or design. Explicit team/shared
intent loads the workflow. Likely collaboration without an indicated preference
asks once whether the customer wants personal or organization use; explicit personal
intent skips the question. After build and readiness, ask for the organization and
guide sharing, with the existing-record/full-member/owner-host disclosure.

## Implementation boundaries

- Canonical pack discovery and existing Matrix/Claude/Codex/Hermes/Agent installation.
- Focused building, conversion, troubleshooting and two-account references.
- Runnable React example: real production build and readiness inspection; CRUD,
  revisioned writes, change rereads, draft retention and subscription cleanup.
- Portable canonical schema-digest helper. Default read-only; explicit write updates
  compatibility only. No certificates, credentials, runtime or permission APIs added.
- Browser-data migration requires a preview, backup, an existing atomic import path,
  and explicit approval before deleting source data. No automatic importer shipped.
- Separate public docs PR in `FinnaAI/matrix-os-site` under `content/docs/guide/`.

## Acceptance matrix

| Actor/state | Action | Expected result | Verification |
| --- | --- | --- | --- |
| Builder with canonical pack | Install/discover skill | Metadata, references and example available to each harness | Real sync script in isolated temporary roots; installer inventory parity |
| Owner app with declared tables | Calculate digest/build | Existing manifest values preserved; production verifier passes compiled React | Helper against gateway canonicalization; actual Vite/TypeScript and immutable build store |
| Existing owner records | Open, CRUD, reopen | Original records retained, mutations reread authoritative state | Rendered example against schema-checked bridge fixture |
| Member change while owner drafts | Change signal | New records visible without destroying draft | Rendered example with revision change |
| Conflict/lost response/offline | Failed save/review | Draft retained; no automatic fresh mutation | Rendered failure injection |
| Owner/member normal accounts | Share/use/reload/restart/stop | Same owner Postgres data, membership-derived full access | Live runtime required; pending until actually exercised |
| Web Canvas/Desktop/Electron/web mobile | Run example and sharing flow | Working UI per surface | Separate live captures; DOM tests cannot qualify these |

Native Mobile remains outside V1 shared-app runtime support. Recommend collaboration
and builder-owner review. Report build, runtime readiness and two-account behavior
separately. Provide copyable Slack text only; no automatic channel post.

## Implementation validation

- Red: the real skill synchronizer did not install this skill. Green: installed
  resources and production loader discovery pass on all five harness targets.
- Real gateway action parsing rejected an invalid insert shape in the renderer
  test; the corrected CRUD workflow now passes.
- The built React example passed every production capability-verifier gate using
  the immutable build store. The first compiled variants were blocked by the
  conservative inspector; ES2022, classic JSX and unminified names preserve the
  actual reachable bridge calls. No verifier behavior was weakened.
- The schema-preservation test uses the existing PostgreSQL-compatible test engine
  and real app registry/query engine. UI failure tests use a schema-checked bridge
  fixture. Neither is live owner/member authentication or VPS qualification.
- Focused `bun run test`: 133 assertions passed across seven suites. Full repository
  typecheck passed. Pattern scan: zero violations, five existing warnings.
- Focused example/helper coverage: 92.07% lines, 86.71% statements, 95.23%
  functions, 78.68% branches. Measurement disabled repository-wide thresholds to
  report this scope; it is not a claim of the requested 99–100% coverage target.
- Public-site tests: 540 passed after building its workspace prerequisites.
- Live Matrix login is available, but this skill/example is not installed there
  and a second account was not exercised. Four-surface evidence remains pending.
  The local public-guide preview failed during Next compilation when disk space
  was exhausted; its generated cache was removed. Responsive captures remain pending.
