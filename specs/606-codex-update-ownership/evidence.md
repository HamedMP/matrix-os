# ENG-298 — Terminal Codex update ownership and explicit runtime promotion

Source baseline: `0348437bc120a37d861904fa7969066e8bbe9222` (2026-10-14). This packet describes an isolated code candidate, not an installed customer fix.

## Report and root cause

[ENG-298](https://linear.app/matrix-os/issue/ENG-298/codex-pinned-at-01561-on-customer-vpses-npm-i-g-openaicodex-lands-in-a) and its complete exploration/plan describe one customer VPS on bundle `v2026.10.14-1767`: `/opt/matrix/runtime/node/bin/codex` and its `/usr/local/bin` link report 0.156.1, while a user npm install created 0.162.1 under `~/.local`. This task read the [complete Slack thread](https://app.slack.com/client/T0C11D9M36Z/C0C459830FJ/thread/C0C459830FJ-1791983925.023589); handoff-to-Chat is a separate request and remains outside this fix. No fleet count or customer-host state was measured here.

The pinned Hermes installer writes its private Node's npm global prefix to `~/.local` and links its Node/npm/npx commands into that bin directory. An unprefixed `npm install -g` can therefore update a second copy while managed consumers retain the old copy. A shell hash can contribute to selection, but rehashing cannot change an absolute-path consumer or the platform's version policy.

Current main differs from the earlier ticket exploration: both Codex protocol records already include 0.162.1, including Linux x64 and Darwin arm64 full-schema digests. The customer installers and shared runtime contract remain at 0.156.1. The scope worker independently remains at 0.154.0 despite defaulting to the same managed executable. Protocol records alone do not prove every consumer's CLI options work.

## Resolution and ownership map

| Entry or consumer | Baseline resolution | Candidate behavior |
|---|---|---|
| Terminal agent menu | `codex --no-alt-screen`; shell PATH/hash decides executable | Same user-visible command; recognized local npm shim points at managed Codex after install |
| Terminal install action | Explicit runtime npm prefix and `CODEX_VERIFIED_NPM_PACKAGE` | Installs exact promoted 0.162.1 into that prefix |
| User `npm -g` through Hermes npm | Hermes private npmrc redirects to `~/.local` | Hermes npmrc points to managed prefix; private Node/npm/npx links remain |
| Tool-pack and boot developer-tools reconciliation | Exact 0.156.1 install/check | Exact 0.162.1 install/check; no automatic arbitrary-latest promotion |
| Server-configured native Chat and event bridge | `codexExecutableFromEnv`: absolute managed executable; version gates differ by consumer | Same executable; launcher/child exact gate advances to 0.162.1; retained protocol records still govern parsing |
| Generic workspace routes/startup fallback | Bare Codex, owner local bin before runtime bin | Recognized npm shim migration converges these; custom commands intentionally remain owner-controlled |
| Isolated scope worker | Absolute `/opt/matrix/runtime/node/bin/codex`, separate exact 0.154.0 gate | Exact 0.162.1 gate and corrected strict-config invocation |
| Docker development images | Independent 0.156.1 build argument | Same promoted 0.162.1; Docker remains a development/CI surface |

Owner `~/.npmrc`, project npm config and environment overrides remain authoritative. Their presence must be diagnosed with `npm prefix -g`, not by printing credential-bearing config. A custom command or unrelated symlink is preserved. A recognized npm shim is redirected only when the managed executable exists; old package bytes remain. Repointing the same path also handles a cached local command path, but a running process must be restarted when idle. This is not a universal `hash -r` workaround.

## Implemented boundaries

- Ship an explicit runtime npmrc for new bundles. On legacy hosts, do not create or rewrite root-owned runtime configuration: runtime npm already derives its managed prefix. Repair only owner-local Hermes npmrc and the recognized local Codex shim.
- Invoke the helper as the runtime owner after successful Codex or Hermes installation. Include the helper in the host bundle's explicit scripts allowlist. Failed required reconciliation fails the installer and can be retried.
- Replace npmrc atomically, preserve unrelated options and file mode, reject configuration symlinks, and keep custom commands and old package data.
- Explicitly promote all shared-executable pins to 0.162.1; retain exact version checks and unknown-version rejection. Broad qualified-version admission and automatic future promotion are deferred design work.
- Remove scope worker's obsolete `disable_response_storage` override. The actual 0.162.1 process rejected it under strict config. A loopback-only real-binary fixture now verifies a completed synthetic response, no offered tools, no Authorization header and `store=false` without that obsolete option.

## English cases and observed evidence

| Case | Steps and expected result | Observed result |
|---|---|---|
| C1 — Hermes global destination | Start with Hermes npm prefix pointing at owner `.local`; reconcile; global prefix should match managed runtime | Real task-local Node/npm fixture: Hermes prefix changes from owner `.local` to managed prefix; runtime npm prefix stays correct without creating runtime npmrc |
| C2 — Recognized duplicate shim | Create relative or absolute npm Codex link; provide executable managed CLI; reconcile and invoke old command path | Both link forms reach managed version; no package deletion |
| C3 — Owner command preservation | Use a regular custom command, unrelated symlink and owner npmrc | Contents/targets and owner override remain unchanged |
| C4 — Missing managed CLI | Leave old npm shim and remove managed executable | Old shim remains; no broken replacement |
| C5 — Legacy permissions | Make runtime prefix read-only with no etc directory; keep owner-local Hermes config writable | Repair passes without privileged runtime writes |
| C6 — Config symlink | Point Hermes npmrc at another file | Fails safely; target file unchanged |
| C7 — Version consistency | Check installers, Docker, contracts and scope worker against explicit promoted pin | 0.162.1 across consumers; unknown-version checks retained |
| C8 — Actual scope process | Exact published binary, empty HOME, fake loopback Responses server, fixed production args | Red: strict config rejects removed field. Green: completed synthetic answer, zero offered tools, no Authorization header, `store=false` |
| C9 — Packaging | Inspect host bundle's scripts allowlist and installer wiring | Red before explicit helper copy; green after packaging fix |
| C10 — Model visibility | Inspect the affected account's official model catalog on its actual Terminal runtime | Not performed. No claim that this fix alone grants sol 6.1 or any account entitlement |

Final affected-scope run under Node 24.18.0: **28 files passed; 348 tests passed; 3 intentionally skipped**. This includes the actual published binary case with `CODEX_CONTRACT_BINARY` set. Its default unit invocation skips that case unless an exact isolated binary is supplied; it never borrows a user's authenticated CLI from PATH.

Workspace native typechecks and explicit scope-runtime `tsc --noEmit` passed. Pattern scans reported zero violations (five existing full-tree warnings, two changed-scope warnings). Shell syntax and `git diff --check` passed. A complete Node 24 unit run is still being collected; do not infer full-suite or CI success from these focused results.

The machine's default Node 25 caused 52 WorkRail failures (`localStorage.clear is not a function`) on both candidate and unchanged main. Unchanged main under the repository's Node 24.18.0 passed both WorkRail and Task Manager suites: 96 tests. The Node 25 run was interrupted; it is not a valid green receipt.

Published Darwin arm64 0.162.1 reports `codex-cli 0.162.1`. Its generated full app-server schema SHA-256 is `e4e7f0c7d3fd77c48cd8619cad2bf2b315d860ab006ad5a7ebe44f6e32e666c1`, matching the retained record; all consumed semantic digests passed the verifier. Linux schema equality was checked against the retained fixture only; no Linux executable or live customer acceptance is claimed here. The local scope fixture excludes loopback from macOS system proxy fallback; no host proxy settings were changed.

## Independent review and landing gates

The independent review of the initial implementation found three P1 issues: missing bundle copy, legacy prefix EACCES, and the real CLI's removed config option. Each received a failing regression before its correction. This does not count as a GitHub approving review of the final head.

ENG-268 PRs #2547/#2548/#2549/#2545 were read for metadata and changed files. This branch changes no files in that stack's auth/UI diff. The shared promoted contract affects their runtime dependency, so they must still be tested against the final installed CLI; none of those PRs was changed or merged here.

Follow `docs/dev/fast-ci.md`: current main baseline, current-head Greptile 5/5 (or formally accepted carry-over), no unresolved review threads, add fast-ci before ready-for-ci, actual green CI Results, and an independent approving review last. No merge, publish, deployment, Main/customer change or Slack message occurred while producing this packet. Live Linux scope isolation, Hermes browser/bridge acceptance, affected-account model visibility and public documentation coordination remain distinct acceptance work.
