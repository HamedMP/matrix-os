---
status: active
---
# Implementation plan

U1: Shared protocol, manifest schemas and owner/public client contracts.
Goal: one bounded source of truth for metadata, forms, versions and safe errors.
Files: packages/contracts/src/sites.ts; index.ts; tests/contracts/sites.test.ts.
Execution note: test-first. Verify malformed field/action/path metadata rejected.

U2: Platform registry, private storage, routes, public renderer and Worker.
Goal: active versioned public deployments, stable IDs/aliases, safe anonymous runtime.
Files: packages/platform/src/sites/*; focused migrations; platform registration wiring; packages/edge-router/src/sites.ts and wrangler.sites.toml; tests/platform/sites*.
Execution note: test-first. Follow database/run-migrations.ts, platform-token.ts, chat-share-proxy.ts. Verify ownership, concurrency, failed uploads, unpublish assets and source isolation.

U3: Gateway deployment producer, private submission repository and service transport.
Goal: build and upload checked app output, expose owner controls, persist named anonymous submissions.
Files: packages/gateway/src/sites/*; gateway registration/auth wiring; tests/gateway/sites*.
Execution note: test-first. Follow app-runtime/build-orchestrator.ts, app-db.ts, request-principal.ts. Verify limits, auth, exact schema, deduplication, record readback and restart/revoke behavior.

U4: Shared owner publishing dialog/client and submission management.
Goal: publish/update/alias/rollback/unpublish and durable form record management available in shared app surfaces.
Files: shell/src/components/app-sites/*; shared AppViewer integration; Electron adapter if independent; tests/ui/app-sites*.
Execution note: test-first. Follow shared dialog primitives and existing apiFetch. Verify loading/error and stale active-app guards, success-only clears, safe errors, version/actions and submission readback.

U5: Integration acceptance, review, documentation and PR delivery.
Root owns cross-unit wiring checks, integration/browser evidence, public docs companion, Linear updates and review. Use separate explicit file ownership for agents; shared-directory agents do not stage/commit or run the full project suite. Root runs all checks and creates PR. Keep specifications stable during implementation; evidence/progress in workpad.

## GitHub Stack Plan

One ENG-231 ticket links four GitHub native dependent PRs, each below 3,000 additions and 50 files:

1. `codex/public-app-sites-contracts`: public contracts, specification and app-builder guidance.
2. `codex/public-app-sites-platform`: publication registry, isolated renderer, Worker, recovery and erasure.
3. `codex/public-app-sites-gateway`: checked deployment producer, private submissions and integration fixture.
4. `codex/public-app-sites`: shared owner controls and Electron adapter.

Use official `github/gh-stack` adoption/submission. Preserve the tested complete-tree snapshot before splitting; every layer links this spec and shared ticket. Current-head review and CI apply separately to every layer. Live owner-surface screenshots/recordings and Slack sharing remain explicit release/readiness gates, not claimed by local browser evidence.
