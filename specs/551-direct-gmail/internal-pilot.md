# Internal Gmail pilot with explicit Pipedream choice

Keep Matrix-owned Gmail limited to an explicit list of immutable Clerk user IDs. Google remains in external Testing with named Google test accounts. Existing Pipedream accounts and their action transport remain unchanged. A user may explicitly connect Gmail through Pipedream at any time. Never retry writes through a second connection.

## Auth and source of truth

- Verified Matrix identity maps to the integration owner's stored `clerk_id`; a bounded operator allowlist grants pilot eligibility. Empty configuration grants no native Gmail access.
- Eligibility is checked before native consent, on the authenticated launcher/callback and before native token use. Removing a tester blocks execution while retaining revocation and deletion cleanup.
- Persisted account identity selects the action transport. Connection labels remain explicit and distinct when both methods are connected.
- Google consent is performed by each tester. Matrix cannot consent on another user's behalf.
- No public enablement, automatic account migration, write fallback, or automatic duplicate send for comparison.

## Route matrix

| Route | Auth | Behavior |
|---|---|---|
| GET /api/integrations/gmail/connection-options | Verified Matrix owner | Server-derived method list; Pipedream always available |
| POST /api/integrations/connect | Verified Matrix owner + validated method | Explicit Pipedream uses existing consent; native choice requires pilot eligibility |
| GET /auth/gmail | Verified initiating owner + stored consent state | Recheck pilot eligibility |
| GET /api/integrations/gmail/oauth/callback | One-use state + signed browser proof | Recheck initiating owner's eligibility before persistence |
| Existing action routes | Existing owner, bot grant and approval | Select persisted account; native use requires eligibility |
| DELETE /api/integrations/:id | Verified owner | Confirmed cleanup remains available after eligibility removal |

## Execution units

### P1 Backend policy and connection capabilities

Files: contracts integration-marketplace.ts; gateway native-gmail policy/runtime/oauth/routes modules; integration routes composition; platform native-gmail-startup/platform-startup; focused contracts, native Gmail and platform tests.

Approach: tests first; shared bounded connection schemas; allowlist at runtime; expose an authenticated capability response; route explicit Pipedream consent through the existing handler. Keep additions out of large entrypoints by extracting focused route/policy helpers.

Verification: pilot/nonpilot/empty/invalid allowlists; forged identity; eligibility removal after consent and before token refresh; direct denial without any provider call; explicit Pipedream invokes no native consent; existing Pipedream remains available; removed testers retain confirmed disconnect/deletion cleanup. No native identifier reaches paid Pipedream execution.

### P2 Shared connection choice across OS views

Files: shell IntegrationsSection and extracted Gmail choice/request helpers; shared UI integration components if needed; Native Mobile integration requests/query/screen and focused tests.

Approach: consume P1's server-derived capabilities and shared labels/types from integration-marketplace.ts. Provide the same two choices, loading/error/cancel states and explicit selected method in Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile where integrations exist. Nonpilot users retain ordinary Pipedream connect behavior. Do not infer internal membership in clients.

Verification: both choices send the exact method; nonpilot/failed discovery does not enable native consent; cancel makes no request; duplicate clicks do not create parallel consent; method and return URI survive Native Mobile requests; existing connection labels/selection remain intact.

### P3 Deployment and public documentation

Files: .env.example; platform-cloud-run.yml and native-gmail-deployment tests; private site Gmail guide and contract tests.

Approach: configure a bounded immutable-ID pilot allowlist, default empty; retain cleanup secrets while off. Document Google Testing's tester list and temporary authorization lifetime, explicit Pipedream choice and no write comparison/fallback. Keep actual tester IDs, emails and secrets out of public files.

Verification: workflow validates and binds allowlist; incomplete/oversized inputs fail safely; disabled retained cleanup remains possible. Public guide tests and MDX compile; code builds, targeted regressions and review; current-head Greptile 5/5 and ready-for-ci.

## Live pilot prerequisites

Named Matrix accounts and Google test email addresses remain required input. Prepare dedicated Secret Manager settings and a scoped runtime deployment after code review/CI. Keep wider rollout disabled. Use synthetic messages for initial verification and require explicit approval for each test send.
