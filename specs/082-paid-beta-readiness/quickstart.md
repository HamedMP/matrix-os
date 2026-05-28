# Quickstart: Paid Beta Readiness Validation

## Prerequisites

- Run from repo root.
- Use Node 24+, pnpm 10, bun.
- Start with a clean paid-beta test user or reset that user's onboarding completion marker.
- Do not use Docker Compose as the production customer-runtime path; customer runtime validation targets VPS-native services.

## Local Checks

```bash
bun run typecheck
bun run check:patterns
bun run test
```

## Targeted Unit And Contract Checks

```bash
bun run test -- tests/gateway/onboarding-activation.test.ts
bun run test -- tests/gateway/activation-readiness-routes.test.ts
bun run test -- tests/gateway/admin-control-routes.test.ts
bun run test -- tests/gateway/integrations-routes.test.ts
bun run test -- tests/gateway/symphony-workflow.test.ts
bun run test -- tests/kernel/onboarding.test.ts
bun run test -- tests/platform/launch-readiness.test.ts
bun run test -- tests/platform/launch-entitlement.test.ts
```

## Visual And E2E Checks

```bash
pnpm --dir shell exec playwright test ../tests/e2e/onboarding-activation.spec.ts ../tests/e2e/onboarding-visual.spec.ts --config ../tests/e2e/playwright.config.ts
```

Required evidence:

- Desktop onboarding screenshot follows Matrix website PR #162 branding.
- Mobile onboarding screenshot has no cropped text, overlap, or hidden primary action.
- Reduced-motion mode disables non-essential animation while preserving progress clarity.
- Missing product media shows a polished fallback.
- No-Claude user completes onboarding with Hermes active.
- Claude/Codex-connected user can still complete a Hermes-owned app-building or assistant task.
- Admin/control surface shows model/provider setup, settings, automations, activity, and readiness remediation in the Matrix visual language.
- Coding-focused user connects GitHub, selects a project, and sees next coding action.
- Assistant-focused user connects or skips calendar/email and sees available/degraded workflows.

## Staging VPS For Breaking Feature Tests

Use a separate runtime slot when a branch or host bundle may break the primary
workspace. The same Clerk login can route to either runtime.

1. Publish the branch host bundle as an immutable version.
2. Provision a staging runtime for the same Clerk user with a distinct handle.

   ```bash
   curl --fail --silent --show-error \
     -X POST "$PLATFORM_PUBLIC_URL/vps/provision" \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"clerkUserId":"user_xxx","handle":"hamedmp-staging","runtimeSlot":"staging"}'
   ```

3. Deploy the branch version only to that staging VPS.
4. Open the same login at:

   ```text
   https://app.matrix-os.com/?runtime=staging
   ```

5. Return to the primary VPS with:

   ```text
   https://app.matrix-os.com/?runtime=primary
   ```

The platform stores primary and staging as separate `user_machines.runtime_slot`
rows, so a failed staging upgrade must not overwrite or route traffic away from
the primary runtime.

Recover a staging VPS by slot so the primary runtime stays attached to the same
login:

```bash
matrixctl recover user_xxx --slot staging --allow-empty
```

## Golden Path: Fresh Workspace

1. Create or invite a new founder/developer test user.
2. Complete signup and wait for provisioning.
3. Open Matrix shell.
4. Confirm onboarding teaches what Matrix can do before requesting credentials.
5. Select "code with Matrix".
6. Connect GitHub or use the mocked GitHub connector in test mode.
7. Select repository/project and task source.
8. Connect Claude or skip it.
9. Connect Codex or skip it.
10. Verify Hermes remains available if Claude is skipped or if Claude/Codex are connected.
11. Start one coding task through Matrix.
12. Confirm Symphony run status and terminal access point to the same project/workspace context.
13. Confirm final result is completed, failed, needs-input, or handoff-ready without duplicate active runs.

## Golden Path: Hermes As Always-On System Agent

1. Start onboarding with no Claude credential.
2. Skip Claude login.
3. Confirm Hermes is shown as active system agent.
4. Ask Matrix to guide app building or complete an approved assistant task.
5. Confirm action summary is safe and understandable.
6. Connect Claude later.
7. Connect Codex later or mark it skipped.
8. Confirm agent readiness upgrades without workspace reprovisioning.
9. Ask Hermes to perform another supported app-building or assistant task.
10. Confirm Hermes remains available and the task completes or coordinates with the connected specialist agent.

## Golden Path: Assistant Integrations

1. Select "use Matrix as an assistant".
2. Connect calendar and email or mark them skipped.
3. Approve one capability for Hermes.
4. Ask Matrix to add a calendar event, read relevant email, or summarize updates.
5. Confirm approval is required for externally visible action.
6. Confirm action summary does not expose provider secrets or raw errors.

## Golden Path: Admin Control Surface

1. Open Matrix settings/admin control.
2. Inspect model/provider cards for Hermes, Claude, Codex, and connected integrations.
3. Start or resume a setup wizard session and reload the page.
4. Confirm the session resumes without duplicate external actions.
5. Open settings/configuration and verify save/reload states are clear.
6. Open automations/activity and verify tasks, approvals, recent activity, and readiness remediation are visible.
7. Confirm the visual language follows Matrix PR #162 rather than copying Finna Cloud directly.

## Operator Readiness

1. Open the operator launch readiness report.
2. Verify gates for activation, provisioning, shell routing, onboarding UX, integrations, Hermes system-agent continuity, agent execution, coding handoff, company brain, support/growth drafts, admin/control surface, and entitlement.
3. Force at least one gate failure.
4. Confirm the report shows pass/fail/blocked status, owner, last check time, and safe remediation.
5. Confirm paid beta is not marked launch-ready until all release-critical gates pass for one fresh workspace and one existing workspace.

## Done Criteria

- Spec checklist passes.
- All targeted tests pass.
- Full pre-PR checklist passes.
- Visual QA evidence is attached to the implementation PR.
- Public docs under `www/content/docs/` explain onboarding launch readiness and deferred payment work.

## Latest Implementation Validation

These results are the current local evidence for this implementation branch.

| Check | Result | Notes |
|-------|--------|-------|
| `bun run test -- tests/platform/launch-readiness.test.ts tests/platform/launch-entitlement.test.ts tests/platform/profile-routing-vps.test.ts tests/platform/profile-routing.test.ts` | PASS | 4 files, 29 tests. Covers operator launch gates, entitlement preservation, app route mount, and existing profile/VPS routing compatibility. |
| `bun run typecheck` | PASS | Observability/kernel build plus package typechecks completed. |
| `bun run check:patterns` | PASS with existing warnings | 0 violations. Existing baseline warnings remain for body consumption, Map/Set review, path operations, and external headers. |
| `bun run test -- --reporter=dot` | PASS | 459 files passed, 3 skipped; 4,752 tests passed, 20 skipped. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_bWF0cml4b3MudGVzdCQ= pnpm --dir shell build` | PASS | Uses a local test Clerk publishable key, not the example production placeholder. |
| `pnpm --dir shell exec playwright test ../tests/e2e/onboarding-activation.spec.ts ../tests/e2e/onboarding-visual.spec.ts --config ../tests/e2e/playwright.config.ts` | PASS | 8 onboarding activation and visual QA specs passed. Shell logs expected gateway proxy refusals because the tests mock onboarding APIs without running the gateway. |

PR/CI, Greptile review, and real-environment operator evidence flags must still be added before this feature is called launch-ready.

## Backend Route Review And PR Invariants

### Source Of Truth

- Gateway onboarding readiness remains owner-scoped readiness state and safe browser summaries.
- Platform launch readiness is the operator source of truth for paid-beta enablement. It combines platform DB facts, such as beta release and machine rehearsal state, with explicit QA evidence flags for launch gates that require human or e2e confirmation.
- Entitlement policy in `profile-routing.ts` is data-preserving policy only; billing remains deferred.

### Lock And Transaction Scope

- Launch readiness reads platform DB state and does not perform writes.
- The operator readiness route has no external network calls and no multi-write transaction scope.
- Entitlement decisions are pure functions and do not mutate machine records or owner data.

### Acceptable Orphan States

- Missing QA evidence leaves the operator report blocked.
- Missing beta release promotion leaves paid beta blocked.
- Missing or expired entitlement blocks paid-only access while preserving owner data and exportability.

### Auth Source Of Truth

- `GET /api/operator/launch-readiness` is protected by the platform bearer token using constant-time token comparison.
- Owner onboarding and admin-control routes remain owner-authenticated through their existing gateway request-principal paths.

### Deferred Scope

- Clerk billing enforcement and payment collection are not enabled here.
- Durable owner-scoped onboarding persistence beyond the current readiness services remains a follow-up if the launch rehearsal requires it.
- Visual QA screenshots and CI/Greptile artifacts are required before launch-ready signoff.
