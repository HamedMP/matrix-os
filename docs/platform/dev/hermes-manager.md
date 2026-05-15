# Hermes Manager

Hermes Manager is the first-party Matrix app and gateway subsystem for configuring, messaging, and operating Hermes as the Matrix orchestrator.

## Runtime Wiring

- App: `home/apps/hermes-manager`
- Gateway routes: `/api/hermes/*`
- Gateway subsystem: `packages/gateway/src/hermes/`
- Owner state: `matrix_hermes_manager_state` in owner Postgres through Kysely
- Secrets: `~/system/hermes-manager/credentials/`
- Hermes bridge: `HermesBridge` in `packages/gateway/src/hermes/bridge.ts`

The app never talks to Hermes directly. Browser calls go through `/api/hermes`, where Matrix request-principal auth, Zod validation, Hono body limits, redaction, duplicate-action locks, and typed bridge errors are enforced.

## Security Invariants

- Browser payloads never include provider tokens, gateway secrets, raw command output, stack traces, or filesystem paths.
- Owner-only operations include credential writes, config changes, gateway restart/update, and export.
- Authorized operators may view status, run channel actions, message Hermes, resolve approvals, and inspect redacted audit state.
- Event streams are capped, stale subscribers are evicted, failed sends are isolated, and shutdown drains subscribers.

## Hermes Bridge

`createLocalHermesBridge()` resolves the local Hermes repo path at runtime, defaulting to `/home/deploy/hermes-agent` or `HERMES_REPO_PATH`. Route handlers depend on the `HermesBridge` interface rather than shelling out directly.

The current bridge provides a local CLI/API-compatible adapter with safe defaults and mocked-test support. As upstream Hermes stabilizes more IPC endpoints, extend `HermesBridge` methods without changing app contracts.

## Validation

Use focused gates during development:

```bash
pnpm --filter '@matrix-os/gateway' exec tsc --noEmit
pnpm --dir home/apps/hermes-manager build
bun run test tests/gateway/hermes-routes.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-event-hub.test.ts tests/default-apps/hermes-manager-app.test.tsx
```
