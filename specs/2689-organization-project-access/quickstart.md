# Quickstart: Verify Organization-wide Project Access

## Prerequisites

- A local PostgreSQL-backed Matrix runtime
- One organization with an owner, an existing member, and a user who can be added later
- The owner has one verified ready Provider Settings route
- Web Canvas, Web Desktop, and packaged Electron Desktop access for visual evidence

## TDD sequence

1. Add failing contract tests for the role-free project access projection.
2. Add failing gateway tests for membership-only project authorization and owner-only administration.
3. Add failing shared-AI tests for current global Provider Settings resolution and no fallback.
4. Add failing UI tests proving the project dialog contains no role, people, model, or acknowledgment controls.
5. Implement the minimum production changes, then refactor once all focused tests are green.

## Focused verification

Run the exact touched suites first, for example:

```bash
bun run vitest tests/contracts/collaboration-capabilities.test.ts
bun run vitest tests/gateway/collaboration-project-sharing.test.ts
bun run vitest tests/gateway/collaboration-project-inheritance.test.ts
bun run vitest tests/gateway/collaboration-authority.test.ts
bun run vitest tests/gateway/shared-ai-eligibility.test.ts
bun run vitest tests/gateway/shared-ai-runtime.test.ts
```

Then run the collaboration regression lane and coverage required by the changed modules. Do not silently skip PostgreSQL-backed assertions.

The final focused implementation lane passed 217 tests with 6 expected repository skips. A touched-module V8 run executed 200 tests with 5 expected skips; its narrowed aggregate did not meet the repository-wide 99% global threshold, so it is evidence of execution and per-module coverage rather than a passing global-coverage lane. The new revocation coordinator reached 94.37% line coverage and the shared-AI registry reached 100% line/function coverage.

## Manual scenario

1. As owner, open a private project and choose **Share whole project** for the organization.
2. Confirm the dialog has no Editor/Viewer, people picker, general-access role, AI source/model, or terms checkbox.
3. As an existing active member, open the project without accepting an invitation.
4. Create/edit project content, start/cancel your own AI request, and exercise an allowed terminal/Git action.
5. Confirm project access alone cannot unshare, delete the whole project, change owner Provider Settings/billing, or administer organization membership; separately confirm an authorized organization administrator retains their organization-policy powers.
6. Add the future member to the organization and confirm they can open/work in the project without the owner changing it.
7. Change the owner's global active AI route. Confirm later member requests use the new route and never fall back to the old one.
8. Make the active AI route unavailable. Confirm member AI fails safely while non-AI project work remains available.
9. Remove a member. Confirm new requests fail and live project sessions are revoked/drained.
10. Remove the project owner from the selected organization. Confirm every non-owner loses access while the owner retains private access and can explicitly share with an eligible organization.
11. Unshare the project. Confirm it disappears from member inventory and all member access ends.
12. Open a legacy standalone share and confirm its existing grant behavior still works.

## Evidence gate

Capture Web Canvas, Web Desktop, and Electron Desktop separately at the reviewed commit/build. Show at minimum:

- simplified project Share dialog
- existing member working in the shared project
- newly added member working without invitation/activation
- safe unavailable AI state after owner route removal
- denied owner-only action

Attach captures or accessible links to the PR, post the same evidence in Slack `#tech` with ENG-29 and PR links, and link the Slack permalink back to the PR. Keep credentials and private customer data out of every capture.

Live qualification requires three authenticated storage states: `MATRIX_COLLABORATION_E2E_OWNER_STATE`, `MATRIX_COLLABORATION_E2E_MEMBER_STATE`, and `MATRIX_COLLABORATION_E2E_OUTSIDER_STATE`. Their absence is a hard evidence blocker, not a reason to skip assertions. Use the exact Playwright CLI from the repository configuration so only one Playwright loader is active:

```bash
node node_modules/@playwright/test/cli.js test --config tests/e2e/collaboration.playwright.config.ts
```

At the implementation head, `bun run typecheck`, `bun run check:patterns:diff`, and `git diff --check` pass. The repository-wide `bun run test` lane remains environment-limited on this host by real socket/HTTP restrictions, GPG/temp access, protected filesystem ancestors, and exhausted data-volume capacity; rely on CI for the unconstrained broad run and do not report the local attempt as passing.

The canonical public guide is updated separately in [FinnaAI/matrix-os-site#338](https://github.com/FinnaAI/matrix-os-site/pull/338).

## Expected result

Sharing is a single owner decision. Every active organization member can work in the project; only membership, project lifecycle, and invisible safety checks restrict them. Shared AI follows the owner's current global Settings and fails closed without fallback.
