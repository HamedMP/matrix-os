# ENG-306 paused checkpoint — 2026-10-15

Paused at the coordinator's explicit priority instruction. Do not resume
implementation, push, review, CI, GUI or new runners until the user resumes this
work. All uncommitted source and tests remain in the original worktree.

- Branch: `codex/eng-306-hermes-v0220`.
- Base/HEAD: `9a15295b31cfb07c08410c99a2fe6163c9a9ed7f`.
- Upstream: official v0.22.0 commit
  `e06df9c2eae6901f4c88f464e0ae6e753c0428b8`.
- No implementation commit, published PR, review result or formal CI yet.

## Implemented locally

PM generation resolver wired into Chat, restricted imports, native metadata,
native key setup and explicit Codex reuse. Installer pins v0.22.0, removes the
unsupported flag and installs the Anthropic extra through PM. Native metadata
uses the tuple credential helper and refuses custom-host credentials for the
fixed official usage probe.

## Actual results

- Focused resolver and metadata run: 17/17 passed.
- Restricted managed/legacy SDK, provider workflow and Chat adapter run: 86/87
  passed initially; one metadata test needed to await asynchronous discovery.
  Subsequent installer/pin/metadata run: 22/22 passed.
- Initial broad Hermes run: 38/39 files passed, 514/521 tests passed. Seven
  fake-timer startup tests raced asynchronous filesystem discovery. After
  isolating the separately tested resolver boundary, the startup suite passed
  16/16. The complete 39-file group was not rerun before pause.
- `bun run typecheck`: passed using task-local Bun 1.4.3.
- `pnpm run check:patterns`: 0 violations, 5 warning categories.
- `git diff --check`: passed at checkpoint.
- Actual upstream PM installed Python 3.14.7, Node 26.7.0, npm 12.0.2,
  ripgrep and ffmpeg in a disposable `/tmp` home. PM committed an Anthropic
  generation; Matrix source-pin and restricted SDK checks passed against it.
- Real upstream process through Matrix's actual Chat adapter: streaming and
  session continuation passed, exactly two loopback model fixture requests,
  zero paid inference requests. This does not prove a real provider/account,
  cancellation, MCP/tool execution, app text completion, GUI or production.
- Full `bun run test -- --maxWorkers=3` was interrupted with SIGINT at the
  requested pause; actual exit 130. It had reported 52 failures in
  `tests/desktop/work-rail.test.tsx` before interruption. Root cause and baseline
  attribution were not investigated; there is no full-unit green claim.

## Unfinished red tests and coexistence

The actual PM npm uses PM Node's global configuration. ENG-298/#2593 at
`aadfe9b66dd2574d6d1c431d078a09134881e090` only repairs the legacy
`.hermes/node/etc/npmrc`. Its files/reconciler have not been copied or modified.
The coordinator has the source/runtime evidence for source-owner coordination.

Four new failing tests in `hermes-matrix-defaults.test.ts` describe PM prefix
repair, invalid entry rejection and symlink rejection; production implementation
was deliberately not started after the pause. Current suite: 2 passed / 4 failed.
Keep these tests and the patch; do not present this checkpoint as merge-ready.

Before resuming: verify branch/patch and upstream/ENG-298 state, complete PM npm
coexistence, consider stricter rejection of a symlinked `environments` root,
expand actual-runtime cases to cancellation/MCP/app text and validate native
dashboard contracts. Then finish required local checks, publish the authorized
draft PR and obtain current-head review/formal CI.

## Runtime and permission boundaries

No Hermes GUI lease has been assigned. Main and the sole Electron instance remain
reserved for the user/sole GUI executor. No Main updates, production calls,
shared configuration changes, owner credentials, new OAuth, paid model calls,
Slack messages, deployment or merge were performed. Screenshots and English
surface acceptance remain pending; initial release screenshots are inputs only.

Raw task logs and a manifest/archive of the uncommitted files are saved outside
the repository in the task's visualization directory under `eng306-checkpoint`.
The disposable source/runtime/toolchain under `/tmp/eng306-*` are retained for
resumption and should be explicitly removed when no longer needed.
