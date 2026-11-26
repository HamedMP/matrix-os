# Local validation

Base: origin/main 8ec4e6b4f (merged without conflicts). Branch: fix/provider-native-chat-preferences.
Ticket: ENG-404. Prepared for draft PR publication; no merge, deployment or owner runtime restart.

## Passed

- Gateway focused run: 8 suites / 201 tests. Includes native start/resume,
  same-process auto review → full access → human approval, catalog, launcher,
  control client, workspace provider, Chat admission adapter, routine source.
- Renderer run: 10 suites / 63 tests before the final additional regression cases.
- Final Desktop provider picker round trip and preference reload: 3 tests pass.
- Final Web switching/reload and existing provider state: 25 tests pass, including
  colon-containing provider instance IDs and legacy selection migration.
- Gateway, Desktop renderer and Web shell TypeScript checks pass. Web typecheck
  rerun after preference storage refinement passes. Contracts also passes with
  TS7 and explicit Node ambient types/type roots.
- Pattern scan: no violations; existing repo warnings include updating expected
  native option arrays in the already large catalog test suite. No new cases
  were added to that large suite.
- git diff --check passes.
- React Doctor changed-code project audit (shell and desktop): no issues after
  replacing an unsupported callback default parameter with a body-local fallback.

## Regression evidence

Original production paths failed assertions for reviewer selection, Claude effort
availability, saved destination permissions/model and Web switching/reload.
The native process regression also fails after temporarily removing the outgoing
reviewer field, then passes after restoration. No fixture/schema-setup failure
counts as regression evidence. Outgoing start/resume/turn frames are checked
against the reviewed Codex 0.162 schema fixture. Native provider is a fake local
process: these tests make no upstream inference calls and do not establish live
model/account availability or actual reviewer decisions.

## Pending qualification

- Authenticated, changed-build visual evidence on Web Desktop, Web Canvas and
  Electron Desktop, at desktop and narrow widths. No surface is visually qualified.
- Native Mobile consumes the shared catalog; its runtime/device check is pending.
- Current-head CI and Greptile review. Existing #2956 remains a related
  Electron-only fix; this draft is self-contained and does not modify that PR.
- Separate public documentation PR in FinnaAI/matrix-os-site; no site files edited.
- PR evidence upload and any separately authorized Slack #tech update.

The generic root TS7 invocation of the standalone contracts config initially
reported missing Node ambient types in unchanged ai-usage/node.ts. The package-local
TS5 attempt exhausted its default heap. TS7 then passed with explicit Node types:
`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json --types node --typeRoots packages/gateway/node_modules/@types`.
No dependencies or lockfile entries changed.

The full workspace typecheck stops in integrations-mcp because kernel/dist is
not built in this isolated checkout. Focused changed-project checks pass. Bun is
unavailable, so equivalent pnpm/node commands are used. The first restricted
production build failed to parse a TypeScript subprocess result; the unrestricted
build passes with NODE_OPTIONS=--max-old-space-size=3072. Post-merge focused tests: 4 suites / 16 tests pass. Web callback audit fix: 25 tests pass.
The full repository test suite is deferred
to CI; local validation targets the changed producer/consumer boundaries.

Logs live outside the repository under /tmp/matrix-provider-*.log and may be
removed once this draft has been reviewed. The isolated worktree preserves all
source work; temporary fake-provider homes are explicitly removed by their tests.

## First review corrections

Greptile identified stale-tab preference overwrites and historical Codex retry
rejection. Production-boundary regressions reproduced both before correction.
Web saves now merge current storage and notify mounted composers; historical
Codex aliases retry with supervised human approval, retaining the old audit record.
Truly simultaneous browser storage writes remain last-writer-wins; this change
protects sequential stale-tab writes and does not introduce transactional storage.
The required feature spec is linked from the plan, PR and ticket.

Review correction validation: 3 suites / 28 tests pass; Web and Gateway typechecks,
React Doctor and diff pattern scan pass (0 violations).
