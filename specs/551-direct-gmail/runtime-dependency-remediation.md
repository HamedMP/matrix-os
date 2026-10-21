# Runtime dependency remediation

Shared ticket: [ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence).
This standalone change supports the provider-data-controls P5 audit-preparation work. It does not approve processing accounts, qualify Google/CASA compliance, or establish the versions installed in a live release.

## Scope

Use pnpm 10.33.4 and the existing seven-day minimum release age. Update only the following dependency families and their required lockfile edges. Preserve Clerk shared 4.x, all unrelated manifests, and the existing Vitest version. Install from the workspace root; validation must use this worktree's own virtual store rather than mutate another worker's install tree.

| Family | Target | npm published (UTC) |
| --- | --- | --- |
| Next / eslint-config-next | 16.3.8 | 2026-09-30 |
| Clerk shared 3.x | 3.47.7 | 2026-05-27 |
| form-data 2.x / 4.x | 2.5.6 / 4.0.6 | 2026-06-12 |
| proxy-addr 2.x | 2.0.8 | 2026-09-15 |
| protobufjs 7.x | 7.6.6 | 2026-08-27 |
| tar 7.x | 7.5.22 | 2026-07-24 |
| shell-quote 1.x | 1.9.0 | 2026-06-25 |

Use major-scoped overrides for transitive patches. Next and its ESLint configuration remain aligned, including the existing package extension needed for dependency resolution. These targets cover additional known advisories that the earliest critical-only fixes leave unresolved.

## Verification

- Demonstrate failing installed-package regressions before updates: forged proxy trust, shell operator newline injection, and predictable multipart boundaries. Re-run them against the patched graph, without network or provider calls.
- Inspect the final root lockfile, preserve the other Clerk major, and bound the review diff below 3,000 additions / 50 files.
- Run focused gateway, platform, bot/runtime, auth and MCP tests; relevant types; the canonical production shell build; native PTY/desktop checks and Native Mobile tests where prerequisites exist. Record exact environment blockers and baseline comparisons; passing synthetic tests are not live surface evidence.
- Reconcile dependency alerts only after the reviewed commit is analyzed. Nested shell/mobile lockfiles are separate stale-artifact cleanup; do not silently regenerate them here.
- The ENG-355 public privacy/help documentation deliverable remains owned by the main feature work. This dependency-only change introduces no product UI or disclosure wording.

## Remaining work

Vitest 4.0.18 remains affected by the reviewed UI/API advisory. The broader fixed 4.1.12 family was published on 2026-10-15; its seven-day gate opens at **2026-10-22 14:51:24.991 UTC** (16:51 Stockholm). Do not add a release-age exception or imply those alerts are cleared by this change. Development dependency classification does not prove exclusion from host bundles, whose builder copies node_modules.

## Primary sources

- [Next 16.3.8 release](https://github.com/vercel/next.js/releases/tag/v16.3.8)
- [Clerk route-matching advisory](https://github.com/clerk/javascript/security/advisories/GHSA-vqx2-fgx2-5wq9)
- [form-data boundary advisory](https://github.com/form-data/form-data/security/advisories/GHSA-fjxv-7rqg-78g4)
- [proxy-addr trust-subnet advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
- [protobufjs schema-code-generation advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg)
- [tar resource-limit advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)
- [shell-quote operator advisory](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p)
- [Vitest UI/API advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
- Publication dates and availability checked against public npm registry metadata on 2026-10-21/22. Recheck at implementation/release time; no advisory dismissal or deployment is part of this change.
