# Connected data verification

Implementation units U1–U5 are complete. U6 publishes the implementation and separate canonical-docs PRs, verifies their exact heads, and applies the Greptile gate. No customer deployment or merge is included.

## Automated evidence

- Independent Graphite layers: OAuth 13 suites / 98 tests; catalog 11 suites / 104 tests; owner imports 6 suites / 62 tests. Broader custom MCP/removal regressions: 24 suites / 121 tests.
- Relevant integration/import/upload suite: 79 files, 639 tests. One stale Notion default-page-size assertion was corrected; all five tests in that file pass on rerun. All other 638 passed in the broader run.
- Owner import tool wiring: 37 tests, including actual MCP client → authenticated gateway → installed manifest → exact connection inventory → persisted owner Postgres pages.
- Late response/body cancellation, absolute OAuth deadlines, callback revision fencing, provider header encoding, parser adversaries, rotating token claims, removal/reconnect races, and queued upload runtime changes have focused regression tests.
- Native iOS/Android bundle CI passes on the original equivalent implementation head; all 115 native suites / 1,079 tests pass. Native picker/config and upload tests pass. The native module additions require a rebuilt version 0.2.6 binary and cannot ship to 0.2.5 over the air. Same-dependency TypeScript baseline comparison reports 46 existing diagnostics on HEAD and changed source, zero added/removed.
- Gateway, platform, kernel, and integrations-MCP builds pass. Gateway/platform/Web Desktop/Electron Desktop type checks pass.
- Canonical production Web Desktop build passes (synthetic public Clerk build key; no live consent).
- Frozen workspace install passes. Full shell ESLint matches HEAD: 135 baseline diagnostics, zero new diagnostics. New upload component lint passes.
- Canonical docs: 268 tests pass; the separate documentation PR has an exact-head Greptile 5/5 review.

## Rendered evidence

The preview uses the actual shared IntegrationMarketplace and actual 38-entry catalog, with sample account metadata. It does not perform authorization. Real provider logos render, including the official Bokio asset. Search, connected/OAuth filtering, and category expansion use the shared implementation. Widths 375, 768, and 1280 have no root horizontal overflow.

Canonical docs for Connect Apps, File System, and Web Mobile render at 375, 768, and 1440 with no root overflow. Tables retain local scrolling. Local preview fixtures are excluded from product commits. Public-safe screenshots of the actual marketplace and selected-upload controls are committed under `docs/pr-evidence/connected-data/`. The upload preview does not fabricate persistence or authorization.

## Review and release limits

All applicable compound review personas completed. Findings were fixed with targeted regression checks. The full repository test command exited before a final summary during local resource pressure; it is not reported as passing. CI remains the full-suite authority.

Live provider OAuth/consent and physical rebuilt iOS/Android picker validation remain release checks. Bokio needs registered platform client credentials and an eligible company account. PostHog/Loops/lemlist depend on actual supported server discovery; unavailable operations fail closed. No account authentication success is fabricated.

HealthKit/Health Connect, AlarmKit, passive device library sync, device-wide contacts, direct Hevy authorization, and chess engines remain deferred by the user's request. Selected imports preserve bytes without automatically invoking AI. App Review acceptance is not guaranteed.
