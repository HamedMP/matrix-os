# Gateway stack refresh: September 5

Baseline: `main` at `a0740cf33`. Integration PR #1493 already brought the
gateway stack into main while deliberately retaining the previous Electron
settings and hiding the managed Chat route. Open PR state is therefore not
evidence that a feature is absent from shipped bundles.

## Original stack accounting

| PR | Scope | Disposition |
| --- | --- | --- |
| #1414 | Canonical provider/account state | Integrated; saved-model fallback review finding fixed in the refreshed tip |
| #1415 | Shared Chat provider state | Integrated; managed Chat activation remains in the refreshed tip |
| #1447 | Provider settings contracts | Integrated |
| #1453 | Provider settings gateway | Integrated |
| #1448 | Shared settings UI | Components integrated; Electron activation restored in the refreshed tip |
| #1449 | Claude SDK and model refresh | Integrated; preserve newer main versions |
| #1451 | Runtime coordinators | Integrated |
| #1452 | Funded control plane | Integrated |
| #1454 | Atomic metering | Integrated |
| #1455 | Account lifecycle | Integrated |
| #1456 | Runtime credentials | Integrated |
| #1459 | Funding summary | Integrated |
| #1460 | Cloudflare relay | Integrated; dedicated deployment remains in #1473 |
| #1461 | Add-on checkout | Integrated |
| #1462 | Generic harness lifecycle | Integrated |
| #1472 | Pi/OpenCode execution | Integrated; resumed-deadline finding already fixed on main |
| #1469 | Generic harness setup/catalog UX | Integrated; preserve newer main Terminal and native model discovery |
| #1473 | Electron Canvas and preview deployment | Restacked onto main; keep unshipped changes only |

#1502 is the surviving follow-up for expanded generic-harness provider/model
selection. It is now based on #1473, not an independent copy of the old stack.
The lower seventeen PRs can be retired as superseded, not represented as
individually merged. Keep their remote branches for recovery/history.

## Review corrections

- Electron uses the same `AgentsProvidersView` and runtime-scoped controller as
  Web Desktop and Web Canvas, instead of the legacy composition.
- Configured funded credentials are not proof of readiness. V3 checks a fresh
  platform policy, positive available credit and budget, and bounded relay
  health. No credential is issued during a settings/catalog read.
- Chat projects Matrix AI only from the ready managed V3 source. It remains an
  access route through Claude SDK, not a new model provider or invented agent.
- Saved unavailable models remain visible and cannot be saved as a silent
  substitute. Choosing a different model is an explicit action.
- Pi discovery disables extensions, skills, context, approval prompts, and
  network refresh. OpenCode discovery disables project config and auto-update,
  preserving the hardened main discovery behavior.
- Managed Chat projection lives in `managed-chat-catalog.ts`; no new projection
  logic is added to the oversized catalog composition module. Further catalog
  decomposition remains separate refactor work.

## Validation and rollout boundary

- Local affected-area suite: 33 files / 428 tests passed, including metering,
  policy, relay, credentials, lifecycle, settings, and UI.
- Canonical Chat plus desktop support: 73 tests passed after refreshing locked
  dependencies. Initial support-test failures came from stale dependency links.
- Full repository TypeScript command passed. Web production compilation and
  TypeScript passed; local prerender needs the deployment Clerk publishable key.
- Deployment is preview-only and must use the final stack head. Do not promote
  a release channel or merge these PRs as part of this refresh.
- Live acceptance still requires exact bundle verification, installed harness
  discovery, shared settings, a real funded response, and ledger settlement.
- Public docs follow-up belongs in the private site repository's `content/docs/`
  after live behavior is accepted; do not publish unverified gateway availability.
