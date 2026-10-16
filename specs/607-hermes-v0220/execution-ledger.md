# ENG-306 local implementation ledger

## Resume boundary

Coordinator explicitly resumed implementation and local synthetic tests after the
review-only phase. No push, external review/CI, installation/download, real
credentials/provider/catalog/model calls, GUI, Main/Private, Slack or merge.

The original 20 files (19 checkpoint files plus the compatibility review) were
archived with hashes and a tracked patch before an explicit scoped stash. Stash
OID and archive remain under the task artifact directory
`eng306-implementation-resume/`. The stash was applied, not dropped.

The original ENG-306 branch was locally rebased onto the exact canonical
dependency `ce625af53362c588d84c8da092c0ddaf1140170e` from ENG-298's original
worktree. Dependency base is `e8cc2cb1e19a6b0afc0d9e30490aaced9a8d8aaf`.
Reconciler SHA-256 is
`196c9acdf25edb000a5bdd0df5f2e23d467ed593e20e4c196fae854537e33b89`;
owner-env SHA-256 is
`fea2c68c9a628a3c9604eb820c8dbcb5bf0c3913b728288a94f4faee48a1760a`.

Ruling: prepare the dependency locally with Git rebase while publication is
forbidden; do not create/change remote native stack membership. Native stack
adoption/publication remains a later separately ordered action. No other branch
or remote ref was rewritten.

## Implementation and regression evidence

- Shared interpreter resolution consumes canonical-source-keyed PM facts for
  Chat, restricted Jev execution, metadata, native key setup and Codex reuse.
  It bounds records to 1 MiB, rejects FIFO/symlink records and escaped state or
  environment roots, checks identity before/after reading and fails closed for
  invalid committed selections. Legitimate venv interpreter symlinks still work.
- Metadata uses the replacement `(token, base_url)` helper plus upstream's
  read-only effective route before accepting official usage access or binding.
  Custom routes and route changes with the same token invalidate the evidence.
- Installer drops unsupported `--force-commit`, pins v0.22.0/e06df9c2, records the
  Anthropic extra through upstream PM and runs the unchanged canonical owner
  npm reconciler once after extras/bundled setup. Owner HOME is explicit.
- Original four npm RED cases targeted mutation of PM-owned global config or
  duplicated dependency-owned defaults. They were removed from the ENG-306 diff;
  frozen ENG-298's 34 passing tests cover external config, legacy coexistence,
  invalid/symlink state, owner overrides (including empty) and root isolation.
  New ENG-306 tests execute the installer hook to prove invocation and ordering.
- Security RED: 8 failed / 20 passed before the bounded-root/effective-route fix;
  GREEN: 28/28. Hook RED: 1 failed / 7 passed; GREEN with dependency: 44/44.
- Independent local read-only review found a prelaunch resolver error that could
  retain a durable native writer fence after a successful cached capability
  probe. A new test failed before the fix (1 failed / 11 passed). The fix maps
  that error to `NativeProviderWriteNotStartedError`; the test also proves no
  writer started and a repaired environment can be retried. Final results below.

## Actual native process fixture

`scripts/spikes/hermes-v0220.ts` reuses only the pre-existing isolated runtime;
no installation or download. Official source e06df9c2, selected Python 3.14.7,
OpenAI 2.24.0 and Anthropic 0.87.0 pass exact source/SDK preflight. Each invocation
has a fresh private marked home, synthetic configuration/key, bounded loopback
model server and a test-only DNS/socket guard refusing external hosts.

Verified native streaming, `read_file` invocation/result, cold-process resume
with the previous user/assistant/tool history, native interrupt cancellation,
and exit of all three children. Four loopback inference requests, zero blocked
external network attempts. Private fixture home and owned sockets are removed.
No owner credentials, catalog calls, OAuth or paid model services are used.

The stronger resume check initially failed because the spike incorrectly passed
resume state into `adapter.start`; production uses the distinct `adapter.resume`
entry point. Correcting the test produced real restored history without changing
production resume behavior. Initial diagnostics/logs remain in task artifacts.

Real stdio MCP discovery/invocation remains **blocked**: the selected existing
environment lacks upstream's `mcp==2.0.0` optional SDK. No package was installed.
Repository synthetic MCP/tool event tests do not replace that native receipt.

## Qualification boundary

Node 24 is used for local gates; Node 25's WebStorage diagnostic in the historical
review is not a product regression. No claim that the full repository unit suite
passed: its old interrupted run is preserved. Affected checks are rerun after the
review fix. Actual app text is a separate literal HTTP path; repository fixtures
exercise it without invoking an agent or real provider.

Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile have no
fresh runtime visual evidence in this scope. No reviewer-approved architectural
N/A exists; those gates and provider-backed acceptance remain unqualified.
Real install/update execution, native MCP, full unit gate, public-site follow-up,
remote stack publication, current-head CI/review and merge remain deferred.

## Final local checks (2026-10-16)

- Node v24.19.0 affected Vitest gate: **41 files / 580 tests passed**, including
  all `tests/gateway/*hermes*.test.ts`, Hermes deploy tests, canonical npm-prefix
  tests and `generic-native-writer.test.ts` (29.35 seconds).
- Full workspace `bun run typecheck`: exit 0 with the existing Node 24 toolchain
  and offline Corepack/pnpm 10.33.4; no dependency installation.
- Actual native-process fixture: exit 0; streaming, genuine builtin tool result,
  cold restored history, cancellation and three-child cleanup passed. MCP blocked
  as described above. Final fixture contains no transcript DB diagnostic code.
- Pattern scan: 5 existing warning categories, 0 violations. Installer shell
  syntax and `git diff --check` passed. Frozen dependency files and test are
  byte-identical to ce625af5; both recorded hashes reverified.
- Independent read-only reviewer re-read the sole P2 fix and regression: resolved,
  no remaining actionable P1/P2 findings. This is local review, not Greptile or
  a replacement for remote CI or runtime acceptance.

Evidence filenames in the task artifact receipt: `eng306-security-red.log`,
`eng306-security-green.log`, `eng306-hook-red.log`, `eng306-hook-green.log`,
`eng306-writer-red.log`, `eng306-affected-reviewed.log`,
`eng306-types-reviewed.log`, `eng306-patterns-reviewed.log`, and
`eng306-native-reviewed.log`. The candidate's exact local commit and file hashes
are recorded outside the commit in `LOCAL-CANDIDATE-RECEIPT.json`.
