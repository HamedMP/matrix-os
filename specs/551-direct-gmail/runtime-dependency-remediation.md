# Runtime dependency remediation

Shared ticket: [ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence).
This standalone change supports the provider-data-controls P5 audit-preparation work. It does not approve processing accounts, qualify Google/CASA compliance, or establish the versions installed in a live release.

## Scope

Use pnpm 10.33.4 and the existing seven-day minimum release age. Update only the following dependency families and their required lockfile edges. Preserve Clerk shared 4.x and unrelated dependency families. Align every existing workspace Vitest/coverage consumer on the same eligible 4.1.12 family. Install from the workspace root; validation must use this worktree's own virtual store rather than mutate another worker's install tree.

| Family | Target | npm published (UTC) |
| --- | --- | --- |
| Next / eslint-config-next | 16.4.1 | 2026-10-14 17:43:55.246 / 17:31:42.399 |
| Clerk shared 3.x | 3.47.7 | 2026-05-27 |
| form-data 2.x / 4.x | 2.5.6 / 4.0.6 | 2026-06-12 |
| proxy-addr 2.x | 2.0.8 | 2026-09-15 |
| protobufjs 7.x | 7.6.6 | 2026-08-27 |
| tar 7.x | 7.5.22 | 2026-07-24 |
| shell-quote 1.x | 1.11.0 | 2026-09-29 02:34:24.391 |
| Vitest / coverage-v8 / mocker | 4.1.12 | 2026-10-15 14:51:24.991 |
| DOMPurify 3.x | 3.4.17 | 2026-10-12 12:41:28.880 |

Use major-scoped overrides for transitive patches. Next and its ESLint configuration remain aligned, including the existing package extension needed for dependency resolution. These targets cover additional known advisories that the earliest critical-only fixes leave unresolved.

## Verification

- Demonstrate failing installed-package regressions before updates: forged proxy trust, shell operator newline injection, and predictable multipart boundaries. Re-run them against the patched graph, without network or provider calls.
- Inspect the final root lockfile, preserve the other Clerk major, and bound the review diff below 3,000 additions / 50 files.
- Run focused gateway, platform, bot/runtime, auth and MCP tests; relevant types; the canonical production shell build; native PTY/desktop checks and Native Mobile tests where prerequisites exist. Record exact environment blockers and baseline comparisons; passing synthetic tests are not live surface evidence.
- Reconcile dependency alerts only after the reviewed commit is analyzed. Nested shell/mobile lockfiles are separate stale-artifact cleanup; do not silently regenerate them here.
- The ENG-355 public privacy/help documentation deliverable remains owned by the main feature work. This dependency-only change introduces no product UI or disclosure wording.

## Remaining work

The Vitest seven-day gate opened at **2026-10-22 14:51:24.991 UTC**. The followup aligns Vitest, coverage-v8 and mocker at 4.1.12, Next/ESLint at 16.4.1, shell-quote at 1.11.0 and DOMPurify 3.x at 3.4.17 without changing pnpm10.33.4 or minimumReleaseAge10080. Installed-library regressions reproduced manual-mock code injection, shell-comment line-terminator injection and the DOMPurify shadow-root template bypass before patches; all nine family regressions pass afterward without executing injected commands/scripts. Next fixes were verified by installed-version/advisory reconciliation and build checks, not an exploit simulation.

The updated runner passed 342 focused tests across17 suites, workspace and bot-runtime typechecks, and a temporary isolated V8 coverage-provider compatibility fixture (100%, removed afterward). The canonical Next16.4.1 production build passes with the checked public CI publishable-key fixture in `.github/workflows/ci.yml`; the absent real account environment first failed prerender. This fixture verifies build compatibility, not deployed auth/provider behavior, and is not five-surface evidence.

Current registry audit still reports other families, including eligible production high advisories. A separate bounded followup will reconcile compatible fixes; source package resolution is not live artifact qualification or full scanner clearance. Development dependency classification does not prove exclusion from host bundles, whose builder copies node_modules.

## Primary sources

- [Next 16.4.1 release](https://github.com/vercel/next.js/releases/tag/v16.4.1)
- [Clerk route-matching advisory](https://github.com/clerk/javascript/security/advisories/GHSA-vqx2-fgx2-5wq9)
- [form-data boundary advisory](https://github.com/form-data/form-data/security/advisories/GHSA-fjxv-7rqg-78g4)
- [proxy-addr trust-subnet advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
- [protobufjs schema-code-generation advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg)
- [tar resource-limit advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)
- [shell-quote operator advisory](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p)
- [Vitest UI/API advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
- Publication dates and availability checked against public npm registry metadata on 2026-10-21/22. Recheck at implementation/release time; no advisory dismissal or deployment is part of this change.

- [Vitest manual mock injection advisory](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
- [shell-quote comment boundary advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)
- [DOMPurify attached shadow-root advisory](https://github.com/advisories/GHSA-cg2g-xh64-v4q7)
- [Next cache typed-array advisory](https://github.com/advisories/GHSA-673q-mjm6-r5xr)
