# Project collaboration validation quickstart

## Product walkthrough

1. Sign in as a project owner with a current Clerk organization and open the project's Share action in Web Canvas.
2. Verify one dialog shows the real organization name, **Everyone in {organization} · Editor**, and the all-current-and-future-content warning.
3. Confirm the revision-bound inventory and keep the dialog open through publication. Exercise a delayed publication, a conflict, and retry.
4. In the published state, verify the immutable Owner, General access choices, activated members, pending direct grants, role changes, inherited Editor precedence, and revocation.
5. Open an existing project Chat as two Editors. Verify named human prompts render on the right, AI/tool output on the left, both participants see one history, and requests serialize through one Chat queue.
6. Open the same Chat as a Viewer. Verify history is readable and the composer remains disabled.
7. Create a new project Chat and verify it inherits the same project audience without another share action.
8. Open Chat sharing outside the project Share dialog. Verify it creates a public read-only snapshot only and exposes no live invite action.
9. Inspect terminal/file/folder/app surfaces. Verify no new live share control appears. For a fixture with an existing legacy standalone scope, verify **Manage access**, recipient read compatibility, and revocation still work.

## Gateway checks

- Project scope create succeeds with the existing owner-runtime preflight and confirmation flow.
- Internal project-inherited Chat scope create succeeds.
- Direct standalone Chat, terminal, file, folder, and app scope creates return a generic forbidden response.
- Existing standalone reads, grant role changes, and revocations continue to authorize from their existing scopes.
- An organization admin with no project grant cannot read the project.
- Editor expands from wire preset `contributor`; Viewer never receives request-AI or mutation capabilities.

## Required commands

Run the focused collaboration Vitest suites, affected TypeScript checks, React quality review, `bun run build:shell:production`, `bun run build:desktop`, and the current Web Canvas/Electron journeys. Save current screenshots in the existing E2E artifact path and link the evidence from the implementation PR.

Use the separate `matrix-os-site` PR to validate the public guide and navigation entry. Do not change Mobile, the topbar, organization management, or `Shared with me` placement as part of this release.
