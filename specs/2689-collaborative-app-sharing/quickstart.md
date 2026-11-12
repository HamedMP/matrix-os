# Quickstart: Implement and Qualify Collaborative App Sharing

This is the implementation and release-qualification path for ENG-29. It is not a claim that the feature is implemented in PR #3123.

## Prerequisites

- Node.js 24+, pnpm 10, Bun, PostgreSQL, and the repository Flox environment.
- PR #3123 and this plan linked to ENG-29.
- Two Matrix accounts in one test organization, plus newcomer, departed-member, wrong-organization, and outsider fixtures.
- An owner-built tracker using declared Postgres tables, with at least 20 records before sharing.
- A disposable Matrix feature-test VPS for stack-head validation.
- Access to Web Canvas, Web Desktop, Electron Desktop, and web mobile runtimes.

Run installs only from the repository root:

```bash
flox activate
pnpm install --frozen-lockfile
```

## Stack rule

Ship the fewest dependency-ordered Matrix OS PRs practical and split whenever a layer approaches 3,000 changed lines. Never exceed ten Matrix OS PRs. The final public-documentation PR is separate and does not count toward ten. Every PR reuses ENG-29 and links the stack. Each code PR contains its own test-first red/green proof; cross-stack qualification happens at the final Matrix OS stack head.

## Red → green workflow for each code PR

1. Name the user outcome and the fault the test catches.
2. Add the failing contract/unit/real-Postgres/integration test against production code.
3. Capture the expected red failure caused by the missing behavior, not fixture setup.
4. Implement the smallest complete layer.
5. Run focused tests and capture green evidence.
6. Run affected typechecks/builds and verify no required assertions skip.
7. Restack onto the previous layer and verify the union.
8. Run coverage for affected packages; new collaborative-sharing code must remain at 100% and overall package coverage must not regress.

Example focused lanes (adjust exact filenames to the implemented layer):

```bash
bun run test -- tests/contracts/collaborative-app-readiness.test.ts
bun run test -- tests/gateway/collaborative-app-readiness-postgres.test.ts
bun run test -- tests/gateway/collaborative-app-share-postgres.test.ts
bun run test -- tests/platform/collaborative-app-discovery.test.ts
bun run test -- tests/ui/collaborative-app-viewer.test.tsx
```

Then run the broader affected lanes:

```bash
bun run test
bun run test:integration
bun run build:shell:production
bun run build:desktop
```

## Headless qualification before UI

Using real Postgres and real owner/platform/gateway boundaries, prove:

1. Exact build readiness fails for browser-only storage, incompatible recipient launch, unsafe provider authority, non-revisioned mutations, schema drift, or missing update signals. A compatible exact build becomes ready without a synthetic second credential; live owner/member sessions prove the complete path during qualification.
2. A passing certificate is invalidated by manifest/schema/asset/bridge/runtime-ABI drift, but not an ordinary compatible host restart.
3. Share creation is atomic/idempotent and creates no half-discoverable scope.
4. Every current organization member, including a guest, discovers/opens without activation, app role, app permission, admin approval, or member row; any current member may share an app they own.
5. Newcomer gains access; departed member, wrong-org member, and outsider lose/never gain discovery, HTML, asset, read, write, subscription, and reconnect access.
6. Owner and recipient see the same 20 existing records and confirmed CRUD after reload.
7. Lost response replay does not duplicate; two stale concurrent writers produce one commit and one recoverable conflict.
8. Owner and recipient mutations use one revision/event path.
9. Stop-share, same-slug replacement, and readiness drift fail closed without deleting owner data.
10. Owner-host restart returns the same confirmed records.

## Local surface validation

Start the production-shaped local source runtime:

```bash
bun run dev
```

For web mobile presentation:

```bash
bun run dev:mobile-shell
```

For Electron:

```bash
bun run dev:desktop
```

On each affected surface:

1. Owner opens the tracker and runs readiness.
2. Owner selects one organization and confirms the existing-data/owner-host/all-members disclosure.
3. Current member opens the typed app item from **Shared with me**.
4. Member sees the 20 existing rows and creates/edits/deletes.
5. Owner sees the confirmed update through a signal followed by authoritative reread.
6. Force a same-record conflict and confirm input remains recoverable.
7. Interrupt the owner host and confirm the rendered app/input remains mounted behind the unavailable overlay.
8. Restore the host and confirm the same records.
9. Remove membership and confirm discovery, requests, subscriptions, and reconnect end.
10. Stop sharing and confirm owner data remains.

Native Mobile is not a qualified V1 runtime. Record an architectural N/A rationale and reviewer approval; a safe “Open on web” listing must not imply native parity.

## Disposable VPS stack-head qualification

At the final Matrix OS stack head:

1. Build an exact host bundle from the stack head.
2. Provision or reuse a disposable feature-test VPS; do not use the requester's primary computer.
3. Deploy the exact published version through the platform rollout path.
4. Verify `/opt/matrix/app/BUNDLE_VERSION`, `/opt/matrix/release.json`, gateway, shell, sync agent, and local health.
5. Run the full actor/data/concurrency/offline/replacement matrix above.
6. Ask whether to delete the disposable VPS after validation to avoid extra Hetzner charges.

Docker Compose is not customer-runtime qualification.

## Live visual evidence gate

Capture each surface separately from the exact stack-head build:

| Surface | Required evidence |
| --- | --- |
| Web Canvas | Owner readiness/share, recipient opens same records, cross-account update, conflict recovery, host-offline input retention. |
| Web Desktop | Shared-with-me app card → shared app window, owner-host attribution, confirmed update, access-ended state. |
| Electron Desktop | Real `WebContentsView` recipient launch, same records, offline/recovery overlay retaining the view. |
| Web mobile | Responsive share flow, app card, recipient edit, conflict/offline recovery. |

For backend-only PRs 1–3, visual evidence may be N/A only with architectural rationale and reviewer approval; attach API/real-Postgres receipts instead.

Put the actual captures or accessible links in every affected PR and Slack `#tech`, with ENG-29, stack/PR links, exact commit/build, scenario, actor roles, and fixture/bypass limitations. Link the Slack permalink back to the PR. Keep captures outside the repository.

## Final documentation deliverable

After the qualified UI/API/copy stabilize, open the sixth deliverable in `FinnaAI/matrix-os-site`:

```text
docs(apps): explain collaborative app sharing
```

Document readiness, existing-record disclosure, organization-wide full access, owner hosting, retry/CAS/change-signal rules, safe participant identity, provider limitations, stop-share behavior, and the distinction from Gallery installs and public Sites.

## Completion gate

- Every Matrix OS stack PR is green, restacked, and Greptile 5/5; the stack stays within ten PRs and every PR stays below 3,000 changed lines.
- New collaborative-sharing code has 100% coverage and overall affected-package coverage has not regressed.
- The stack-head end-to-end matrix passes without skipped required assertions.
- Every affected surface has live evidence in its PR and Slack `#tech`.
- The public docs PR matches the qualified contracts and copy.
- Stakeholder review is recommended from collaboration product/design, gateway/platform, shell/Electron, security, and docs owners.
