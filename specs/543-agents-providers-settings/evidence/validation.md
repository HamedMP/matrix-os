# Local validation

October 1, 2026. Source candidate is `codex/agents-providers-figma`, based on
`951673cebf864669c346ae4a668ec8bb7b1d1ac6`. These checks establish local code
behavior; live provider authentication, inference and Preview runtime acceptance
are separate gates.

- Root `bun run typecheck`: passed after shared profile-guard integration.
- Root `bun run check:patterns`: zero violations, five review warnings.
- Changed backend/contracts/host lifecycle tests: 18 files, 141 passed.
- Final shared UI, Web/Electron adapters and status regressions: 85 files,
  780 passed. The broad run caught old status/button copy assertions; their
  updates retain failure, expiry, offline and explicit Off precedence.
- Final production Web Shell build: passed. Public Clerk publishable-key
  metadata was used for build validation; no login session was copied.
- Final production Electron build and two actual Electron E2E flows: passed.
  Fresh Settings recovered the same active operation without another login
  start. Numbered screenshots and build hashes are recorded separately below
  `electron-fixture/`; the gateway in those flows is synthetic.
- Previously failed non-UI regression files: 42 files, 682 passed. Seven files
  retain 20 failed assertions; all 20 also reproduce on the unchanged base
  checkout in this macOS environment. The base has 22 failures in that set.
- Real Electron API client history routing regression: failed with the runtime
  gateway query appended to the strict platform endpoint; passed after using
  platform routing with the explicit selected ledger runtime slot. Combined
  transport/adapter check: 21 passed.
- Native Node contracts/MCP import checks: 48 passed after correcting the
  contracts package import alias.
- Public site documentation: 233 passed. Four changed routes rendered HTTP 200
  without horizontal overflow at 375, 768 and 1440 pixels.

The earlier full root suite ran while source changes were still underway and
was not green: 1,925 files passed, 59 failed, 27 skipped. Stable reruns above
replace that run for affected files; they do not claim a green full suite.
Changed shell files passed lint. Full shell lint still reports pre-existing
errors outside this change.

## Baseline failures

The unchanged-base comparison used the same installed dependency tree, GNU
coreutils on the child process PATH, and a detached checkout of the base commit.
Production code and tests in that checkout were not modified. The shared
dependency tree includes this candidate's contracts build; the comparison is
specific to the failures below, rather than an independent dependency install.

| Test file | Reproduced failed assertions |
| --- | ---: |
| `tests/platform/customer-vps-registration-client.test.ts` | 8 |
| `tests/platform/customer-vps-update-manifest-trust.test.ts` | 1 |
| `tests/platform/golden-snapshot-host-scripts.test.ts` | 2 |
| `tests/platform/preview-collaboration-workflows.test.ts` | 5 |
| `tests/platform/preview-origin-routing.test.ts` | 1 |
| `tests/platform/speech-local-browser.test.ts` | 1 |
| `tests/gateway/terminal-workspace-routes.test.ts` | 2 |

Examples include unavailable Linux host utilities (`flock`,
`add-apt-repository`) and existing cleanup/preview script expectations. No
candidate-only failure remains in this comparison. Linux CI and real host
acceptance remain necessary; this report does not turn a failed test into a
passing one.
