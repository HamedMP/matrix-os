# Dependency security remediation

Tracking: [GTM-305](https://linear.app/matrix-os/issue/GTM-305/remediate-the-vanta-github-dependency-vulnerability-backlog).

Update the active workspace graph to published patched releases for critical advisories and the affected Undici 6/7 lines. Keep overrides bounded to the compatible major lines. Preserve existing Pi SDK pins, release-age safeguards, Electron/Vite override, branch rules and deployment configuration.

Validation: retain a private baseline and post-change npm audit; verify a reproducible frozen lockfile; run the relevant dependency/tooling tests and shell build. Review remaining advisory paths separately. Do not claim GitHub alerts closed or deployed remediation until the reviewed change is merged and live evidence is collected.

Standalone shell/mobile lockfiles must be reviewed for their role and brought into alignment through their intended package-manager workflow. Do not delete them merely to suppress alerts.

Public documentation follow-up: check the private site repository for any documented runtime/version requirements and prepare a separate documentation PR if these change. This patch introduces no user-facing capability or new API.

Risk: Next.js and Vitest minor releases require runtime/build and test-runner qualification; scoped transitive patches can expose incompatible upstream assumptions. Keep the patch reviewable and do not deploy before those checks.

## Local validation — 2026-10-28

- Node 24.22.1 / pnpm 10.33.4 frozen workspace install passed (install scripts disabled).
- Existing test preparation builds passed. Five focused suites passed, 157 tests total: platform Clerk users and proxy routing, default-app Markdown, desktop Markdown preview and dependency patch packaging.
- Shell production build passed with the repository's existing CI-safe Clerk publishable-key fixture. Compilation, TypeScript, prerender and build traces completed. This is build qualification, not live authentication or deployment qualification.
- Root-workspace dependency audit: critical 17 to 0, high 153 to 118, moderate 165 to 118, low 36 to 20. These are scanner results for the root workspace, not unique exploitable findings or closure of separate shell/mobile lockfiles.
- `git diff --check` passed. Hosted CI, code review and deployed validation remain required. No branch controls changed.

## Follow-up compatible fixes

Upgrade eligible HTTP, parser, authorization and schema dependencies within their existing API families. Align Tiptap packages, preserve peer contracts with parent-scoped overrides, and keep the seven-day package quarantine intact. The XML-parser fix changes mobile fingerprint inputs, so app version 0.2.9 starts a new runtime and requires fresh native builds before release.

Root-workspace scan before review: 0 critical, 13 high, 16 moderate, 12 low. The post-review registry snapshot reports 0 critical, 12 high, 18 moderate, 12 low; advisory database drift is documented separately from code remediation. See [remaining advisory work](remaining-advisories.md) for the still-open families and GTM-305 follow-up; no advisories are dismissed or risks accepted.

Validation: frozen install; affected-package TypeScript; 1,064 focused tests with one pre-existing skip (failed local native/module-layout prerequisites corrected and affected suites rerun); all 3,232 mobile tests; iOS/Android bundle export; shell production build with the existing CI Clerk fixture; desktop production build; Neo and edge-router deployment dry runs; mobile native-change guard; whitespace check. No live deployment or native mobile build was performed.

Companion documentation deliverable: update the canonical private matrix-os-site developer releases page with native runtime/OTA compatibility rules, alongside its own compatible security dependency fixes, and open a separate documentation/dependency PR under GTM-305. Keep its validation and review separate from this public source PR.


### Full-CI compatibility corrections

Full hosted CI exposed two assertions not covered by the initial focused runs. Both reproduced locally before editing production behavior or tests.

- The updated Zod string bound counts Unicode code points. Preserve the canonical chat contract's existing JavaScript UTF-16 budget explicitly in `canonicalBoundedText`; otherwise an oversized optional provider preview is admitted. New ASCII/surrogate boundary and independent byte-limit tests failed before the production fix and pass after it. The original OpenClaw lifecycle regression also passes without dropping its assertion.
- Patched Hono rejects oversized chunked bodies at the route middleware before contacting the home. The old integration assertion required a home call even on rejection. Replace that implementation-specific assertion with exact 413/no-forwarding and bounded input-read checks, plus successful exact-limit and smaller uploads. Keep the independent real relay-stream limit regressions intact; no middleware or limit is removed.

Validation: 105 contract/provider/relay suites, 980 tests passed; affected-package native TypeScript passed. No skips or exclusions were added. Fresh full CI and Greptile review are required on the correction's published head.

The completed fourth shard also found its old static MCP expectation (`^1.29.0`). Update that version contract to the security floor `^1.32.0` while retaining both reviewed Agent SDK pins; all seven SDK/cost/model-control tests pass.


The preserved other-shard logs identified three additional Hono compatibility failures, all reproduced locally. Restore the WhatsApp API's explicit JSON/no-store 413 at middleware ingress, before authentication or linking, and retain verified-owner checks for valid bounded requests. Replace the device test's obsolete Request.formData spy with an actual malformed multipart request through the updated parser; verify generic failure, diagnostic logging, and that the device code remains unapproved. No device authorization implementation changes are required. All 331 tests in 15 WhatsApp/device suites, native TypeScript and the pattern gate pass; the complete final-head CI run remains required.
