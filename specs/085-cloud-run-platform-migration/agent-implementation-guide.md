# Agent Implementation Guide

Use this guide when a coding agent implements the Cloud Run platform migration. Work in a manual git worktree on a Matrix cloud instance, open a PR, and keep each change small enough for review.

## Operating Rules

- Start by reading `.specify/memory/constitution.md`, `AGENTS.md`, and `specs/085-cloud-run-platform-migration/spec.md`.
- Work in a manual worktree, not directly on `main`.
- Use TDD: add failing tests before implementation.
- Keep each PR below 50 files and 3000 additions. Split into stacked PRs if needed.
- Use Conventional Commit style for commits and PR titles.
- Do not add non-Postgres persistence.
- Do not put platform-only secrets on customer VPSes.
- Do not ask for raw secret values. Ask for secret name, target environment, and whether it has been configured.
- Do not print secrets, database URLs, API tokens, cookies, or signed route tokens in logs or final messages.

## Worktree Setup

```bash
git fetch origin
git worktree add -b 085-cloud-run-platform-cloud-mode ../matrix-os-cloud-mode origin/main
cd ../matrix-os-cloud-mode
pnpm install --frozen-lockfile
```

If split, use stacked subsystem branches:

1. `085-cloud-run-mode`
2. `085-runtime-route-token`
3. `085-edge-router`
4. `085-vps-token-ingress`
5. `085-cloud-run-cicd`
6. `085-inngest-workflows`
7. `085-synapse-central`

## Inputs Agents May Ask For

Ask only for missing operator decisions or confirmation: GCP project id, Cloud Run service name, Artifact Registry repo, staging/production Neon branch names, Secret Manager secret names and configuration status, R2 bucket/prefix model, Cloudflare account id and Worker name, Clerk test/production decision, Inngest/PostHog environment names, HMAC vs asymmetric route tokens, and per-VPS vs shared tunnel routing.

Do not ask for raw Neon, Clerk, Stripe, Pipedream, R2, Hetzner, PostHog, Inngest, Cloudflare, or production user secrets.

## Implementation Slices

### Slice 1: Cloud Run platform mode

Files: `packages/platform/src/main.ts`, `packages/platform/src/orchestrator.ts`, `packages/platform/src/customer-vps-config.ts`, `packages/platform/src/db.ts`, `tests/platform/*`.

Implement `PLATFORM_RUNTIME_MODE=cloud_run|compose|local`, startup validation for cloud mode, no Docker socket requirement in cloud mode, required `CUSTOMER_VPS_ENABLED=true`, localhost `PLATFORM_DATABASE_URL` rejection, and optional proxy usage behavior when the legacy `proxy` service is absent.

Tests: cloud mode starts without Dockerode/Docker socket, fails if customer VPS mode is disabled, fails if platform DB URL is localhost, and compose/local mode remains compatible.

### Slice 2: Runtime route-token protocol

Add `packages/platform/src/runtime-route-token.ts` and `POST /runtime/routes/resolve`. Verify Clerk-authenticated route resolution, owned explicit VM resolution, generic failures, short-lived token claims, and PostHog success/failure categories.

### Slice 3: Cloudflare Worker router

Add `packages/edge-router` with host/path classification, Cloud Run proxying, runtime resolver calls, VPS origin forwarding, WebSocket upgrade forwarding, no-store headers, and PostHog safe-property events.

### Slice 4: VPS route-token ingress

Update customer VPS cloud-init/host-bin/gateway tests for cloudflared, nginx route-token gate, shell/gateway/code routing, WebSocket upgrade preservation, code proxy token validation, and safe failure events.

### Slice 5: Cloud Run CI/CD

Add `.github/workflows/platform-cloud-run.yml`, Cloud Run image build/push/deploy with no traffic, tagged revision smoke, gradual or manual promotion, rollback on failed smoke, and no secret echoing.

### Slice 6: Inngest workflows

Add platform Inngest client/functions/routes and tests for user-created provisioning, retry-safe VPS provision, deploy fanout isolation, and categorized provider failures.

### Slice 7: Central Synapse

Add Synapse deployment artifact, reverse proxy config, well-known config, Redis, explicit federation setting, and backup/restore notes.

## Required Validation Before PR

Run relevant subset first, then:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

For Worker changes:

```bash
pnpm --filter @matrix-os/edge-router test
pnpm --filter @matrix-os/edge-router exec wrangler deploy --dry-run
```

For platform changes:

```bash
pnpm --filter @matrix-os/platform exec tsc --noEmit -p tsconfig.typecheck.json
pnpm exec vitest run tests/platform
```

Only run deploy commands after the human confirms target environment and provider secrets are configured.

## PR Body Requirements

Every backend PR must include source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, deferred scope, rollback plan, verification commands, and whether PostHog events/errors were added or deferred.

## When to Stop and Ask

Ask before creating paid cloud resources, changing production DNS, pointing Clerk/Pipedream/Stripe webhooks at new URLs, deploying to production Cloud Run, promoting production traffic, fanout deploying to all VPSes, deleting old resources, or rotating secrets.
