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
- Focused tests: 159 passed across eight suites after the review fixes, with no
  skips; the artifact coverage lane passes 36 tests. Full repository
  typecheck passed. Pattern scan: zero violations, five existing warnings.
- Follow-up recovery/CLI qualification: 36 tests pass against the shipped artifacts.
  Focused example/helper coverage passes the existing 99% statement/line/function
  and 95% branch thresholds: 100% lines/functions, 99.31% statements and 97.20%
  branches. Includes malformed responses, late completions, exact-ID confirmation,
  deliberate draft discard and atomic-write failure preservation. This supersedes
  the initial 92.07% line-coverage measurement; it is not repository-wide coverage.
- Greptile identified the missing owner Retry overlay. The example now offers
  `retryMutation()` only when available; a red/green regression crosses the real
  owner transport and proves retries reuse the original operation ID/revision/payload.
  Members keep their existing Matrix overlay. No fresh mutation is sent on retry.
- A second review reproduced a confirmed-write/late-rejection race. Initial saves
  and retries now show a failure only while their exact attempt remains unresolved.
- Public-site tests: 540 passed after building its workspace prerequisites.
- Installed the example with an unused qualification name/slug on the existing
  owner host (build `6ef6b8ff`, v2026.11.12-1996). App-local pnpm 10.33.4 install
  and production build pass with React 19.3.1/Vite 6.4.6. The genuine authenticated
  readiness control reports this exact build ready on Web Desktop, Web Canvas and
  web mobile (375px); captures are attached to ENG-29 and the PR. This supersedes
  the first unavailable result before dependencies were installed. No share or OS
  update was created. The sample is retained for human verification.
- These captures prove launch/readiness only. Built-in-browser iframe input was
  unavailable, so owner save/reopen and two-account behavior remain unverified.
  Electron UI is unavailable under the requester's browser-only constraint.
  Full surface/journey qualification remains pending; do not call this merge-ready.
- Local full-suite execution was attempted and stopped after 16 minutes; the
  checked-in duration profile totals 152 serial minutes. No complete local result
  is claimed. Full CI was triggered; unit shards 1/4 and 4/4 and Electron E2E were
  interrupted by runner shutdown signals without assertion failures before
  cancellation. Retry CI on the reviewed head rather than changing test policy.
- Public-guide verification:
  The local public-guide preview failed during Next compilation when disk space
  was exhausted; its generated cache was removed. The hosted PR #356 preview then
  passed visual checks at 375, 768 and 1280 pixels, with no root horizontal overflow.
  Captures are attached to ENG-29; these guide captures do not qualify app runtime surfaces.
