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
