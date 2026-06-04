# Operator Setup Guide

This guide is for the human operator setting up managed services and sharing access with engineering. It complements `spec.md` and tells coding agents what has already been configured.

Create one secure password-manager item named `Matrix OS Cloud Platform - Production` with non-secret metadata and links: GCP project id, Cloud Run service, Artifact Registry repository, Neon project, R2 bucket, Cloudflare account id and Worker, Clerk app, Pipedream project/environment, Inngest app/environment, PostHog project, Hetzner project, and Synapse deployment location.

Store secret values only in provider secret stores and the password manager, never in GitHub issues, chats, PRs, or agent prompts.

## Neon

Create project `matrixos_platform`, Postgres 18, region AWS Europe Central 1 Frankfurt. Create database and role `matrixos_platform`, production branch, staging branch template, pooled connection strings for Cloud Run, production pooled URL in Google Secret Manager as `platform-database-url`, and staging pooled URLs in staging secrets.

Tell agents only the Neon project name, branch name, Secret Manager secret name, and whether the secret is configured.

## Google Cloud Run

Create GCP project, Artifact Registry repository `matrix-os`, Cloud Run service `matrix-platform`, service account `matrix-platform-runner`, and Secret Manager secrets for all runtime secrets.

Recommended production settings: `europe-west3`, min instances 1 for beta and 2 before paid users, max instances 10 initially, concurrency 20-40, CPU 1-2 vCPU, memory 1-2 GiB, timeout 60-300s, and ingress behind Cloudflare public route.

Cloud Run env should include:

```text
PLATFORM_RUNTIME_MODE=cloud_run
PLATFORM_PORT=8080
PLATFORM_PUBLIC_URL=https://api.matrix-os.com
CUSTOMER_VPS_ENABLED=true
CUSTOMER_VPS_TLS_VERIFY=true
CUSTOMER_VPS_IMAGE_VERSION=dev
MATRIX_APP_DOMAIN_HOSTS=app.matrix-os.com
MATRIX_CODE_DOMAIN_HOSTS=code.matrix-os.com
NEXT_PUBLIC_MATRIX_APP_URL=https://app.matrix-os.com
POSTHOG_HOST=https://eu.i.posthog.com
POSTHOG_API_HOST=https://eu.i.posthog.com
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
NEXT_PUBLIC_POSTHOG_API_HOST=https://eu.i.posthog.com
```

Cloud Run secrets should include `PLATFORM_DATABASE_URL`, `PLATFORM_SECRET`, `PLATFORM_JWT_SECRET`, Clerk, Stripe, Pipedream, R2, Hetzner, Inngest, and PostHog secrets.

## Cloudflare

Create Worker `matrix-edge-router`, production routes for `api.matrix-os.com/*`, `app.matrix-os.com/*`, and `code.matrix-os.com/*`, staging routes for matching `*-staging` hostnames, customer VPS tunnel naming convention, and WAF/rate-limit rules.

Worker vars:

```text
PLATFORM_ORIGIN=https://api.matrix-os.com
ROUTE_RESOLVE_PATH=/runtime/routes/resolve
RUNTIME_ROUTE_CACHE_TTL_SECONDS=60
POSTHOG_HOST=https://eu.i.posthog.com
```

Worker secrets: `POSTHOG_PROJECT_TOKEN` and `EDGE_ROUTE_SIGNING_SECRET` if the Worker signs edge-local tokens.

## R2

Create production bucket `matrixos-sync` or `matrixos-prod`, staging bucket or prefix, scoped production and staging API tokens, and keep object layout for `system-bundles/`, `matrixos-sync/`, `backups/`, `exports/`, and `staging/`.

Customer VPSes should receive only scoped runtime sync/backup credentials or a platform sync proxy token.

## Clerk

Configure production app for `matrix-os.com`, optional staging app, sign-in/sign-up URLs, redirect URL `https://app.matrix-os.com/`, and webhook events `user.created`, `user.updated`, and `user.deleted`. Prefer Inngest endpoint once implemented; otherwise use Cloud Run webhook route temporarily.

## Pipedream

Configure production and development/staging environments. Callback URLs point to Cloud Run/Worker public routes. Do not put Pipedream credentials on customer VPSes.

## Inngest

Create production app/environment `matrix-platform` and staging `matrix-platform-staging`. Store `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Wire Clerk events, release published events, VPS provision/reconcile/deploy events, billing entitlement changes, and integration events.

## PostHog

Create production and staging projects/environments using EU host `https://eu.i.posthog.com`. Add dashboards and alerts for route-token failures, Worker upstream errors, VPS unreachable rate, WebSocket failures, Cloud Run 5xx, workflow failures, host bundle deploys, sync/R2 failures, and Synapse health.

## Hetzner and Customer VPSes

Keep the per-user VPS model. The platform provisioning flow should create the server, local Matrix user, `/opt/matrix/env/host.env`, `/opt/matrix/env/postgres.env`, `/opt/matrix/env/r2.env`, cloudflared service, nginx route-token gate, and Matrix systemd services.

## Central Synapse

For beta, run one central Synapse deployment in Germany/Frankfurt with Postgres and Redis. Route `matrix.matrix-os.com` through Cloudflare. Do not deploy Synapse on every VPS until there is a product requirement for per-user or per-org homeserver isolation.

## GitHub Environments

Create `staging` and `production`. Staging contains staging deploy credentials/tokens/URLs. Production contains production deploy credentials/tokens, `PLATFORM_SECRET`, and production platform URL. Require manual approval for production deployments.

## Team Access Model

| Team member type | Access |
|------------------|--------|
| Engineer | GitHub repo, staging Cloud Run logs, staging Neon branches, staging Worker deploy, staging PostHog |
| Release owner | Production deploy approval, production Cloud Run, production Cloudflare routes, production Neon read/admin, production PostHog |
| Operator | Billing/admin for GCP, Cloudflare, Neon, Clerk, Pipedream, Inngest, Hetzner |
| Agent | No direct secrets; works through repo, tests, and human-confirmed secret names |

## What to Tell Agents

Provide branch/worktree name, target slice, whether staging services exist, configured secret names, target staging URLs, and whether deploy commands are allowed. Do not provide secret values.

## Cutover Checklist

Before switching production DNS, verify Cloud Run production revision healthy with no traffic, Neon production DB migrated, R2 host-bundle publish works, Worker staging route passes runtime tests, one disposable VPS validates shell/gateway/code WebSockets through Cloudflare, Clerk webhooks and Inngest workflows work in staging, PostHog receives events from all required surfaces, and rollback DNS path is documented.
