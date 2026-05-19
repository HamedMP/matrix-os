# Matrix Engineering Practices

This is the operating manual for Matrix OS engineers and their coding agents.
The goal is not more process. The goal is to give every human and agent enough
shared context to choose high-impact work, split it correctly, verify it on the
same runtime users see, and merge it without accumulating hidden review debt.

## Operating Model

Matrix engineering is cloud-first, agent-assisted, and review-driven. The main
development environment is a Matrix dev VPS so engineers and agents work inside
the same kind of always-on cloud workspace that users should adopt.

1. Pick work from Linear or GitHub with a clear owner, outcome, and target
   surface.
2. Classify the ticket before coding.
3. Use Spec Kit for large or cross-boundary features.
4. Implement each spec phase as a small Graphite stack layer.
5. Develop on a Matrix dev VPS by default; use local development only for fast
   tests, native desktop/mobile work, or infrastructure that cannot run remotely.
6. Open PRs with Conventional Commit titles and explicit invariants.
7. Run CI, pattern checks, and automated review.
8. Fix review comments until Greptile reports 5/5 or all remaining comments are
   explicitly deferred in the PR body.
9. Deploy through the host-bundle release path when users on customer VPSes need
   the change.

## Core Concepts

| Concept | Meaning |
| --- | --- |
| Matrix OS | Web 4: OS, messaging, social, AI, games, apps, and cloud coding under one identity. |
| AI kernel | Claude Agent SDK V1 `query()` + `resume`; agent sessions are the process model. |
| Shell | A renderer over the headless core. Canvas is primary; Desktop compatibility still matters. |
| Owner data | User/org data belongs to its owner. Files hold identity/config/export state; Postgres holds app and workspace data. |
| Customer VPS | Production runtime: one VPS per active user, host systemd services, local owner Postgres. |
| Dev VPS | Per-engineer or shared hot-reload Matrix runtime used to see and feel changes like a real user. |
| Symphony | Matrix-native coding-agent runner connected to Linear tickets, projects, worktrees, and Zellij sessions. |
| Hermes / skills | Shared instruction packs for Matrix-aware agents; provider secrets stay server-side. |
| Host bundle | The deployable customer VPS artifact published to R2 and registered in platform Postgres. |

## Ticket Types

Classify tickets before starting. The classification determines context, tests,
preview path, and review depth.

| Type | Typical paths | Default workflow |
| --- | --- | --- |
| Shell/UI | `shell/`, `packages/ui/`, Canvas, Desktop, mobile shell | Canvas-first, Playwright/screenshot when visual, dev VPS preview for user feel. |
| Default apps | `home/apps/**`, `home/system/icons/**` | Vite app, shipped icon, `node scripts/build-default-apps.mjs home/apps`, app tests. |
| Agentic harness | `packages/kernel/`, Symphony, Hermes, Agent SDK, sessions, Zellij | Spike SDK/runtime behavior first, then Spec Kit if behavior is cross-package. |
| Gateway/API | `packages/gateway/**` | Route-boundary Zod, `bodyLimit`, auth matrix, generic errors, focused route tests. |
| Platform/VPS | `packages/platform/**`, `distro/customer-vps/**`, release scripts | Spec Kit, mocked Hetzner/R2 tests, host-bundle verification, no customer Docker runtime. |
| Integrations | Pipedream, Linear, Gmail/Slack/GitHub providers | Platform-owned secrets, no provider tokens on customer VPSes or in agents. |
| Auth/billing | Clerk, Stripe, entitlements, org access | Explicit auth source of truth, no raw provider errors, adversarial tests. |
| CLI/cloud coding | `matrixos`, Zellij, code-server, workspace sessions | Durable session metadata, native attach plus web fallback, dev VPS smoke. |
| Docs/process | `README.md`, `docs/dev/**`, `AGENTS.md`, public docs | Keep docs short enough for agents, link to source-of-truth details. |
| User operations | Clerk waitlist, provisioning, PostHog, outbound email, support | Use `docs/dev/user-operations.md`; platform owns secrets and customer communications. |
| Durable async workflows | Inngest, Clerk/Stripe/webhook events, retries, sleeps | Use Inngest for website/control-plane workflows that need durable step history; keep gateway/VPS runtime loops local. |

## When To Use Spec Kit

Agents should ask to run Spec Kit before implementing when a ticket:

- touches two or more packages or runtime surfaces;
- adds endpoints, WebSockets, IPC, file I/O, persistence, background jobs, or
  provider integrations;
- changes customer VPS provisioning, release, routing, auth, billing, or owner
  data behavior;
- is likely to exceed 1000 additions or 20 changed files;
- needs a product/security decision that is not obvious from existing specs.

Small scoped fixes can proceed without a new spec, but they still follow TDD and
the mandatory code patterns in `AGENTS.md`.

Spec Kit outputs live under `specs/{NNN}-{feature-name}/`. A complete spec for
Matrix must include:

- user stories and acceptance tests;
- constitution check;
- security architecture and auth matrix;
- integration wiring and startup/shutdown order;
- failure modes, resource limits, and recovery behavior;
- tasks split into reviewable phases;
- public docs updates when user-facing behavior changes.

## Graphite Stack Rules

Use Graphite for any multi-phase Spec Kit plan or feature that crosses review
boundaries. Preserve the spec phase boundaries as stack boundaries.

Recommended stack shape:

1. `docs(spec): add <feature> spec`
2. `feat(<area>): add contracts and storage`
3. `feat(<area>): add runtime/service wiring`
4. `feat(<area>): add shell/app surface`
5. `test(<area>): add e2e or deployment coverage`
6. `docs(<area>): publish operator/user docs`

Each layer should be reviewable alone, ideally under 1000 additions and 20
files. Every PR title uses Conventional Commit style. Backend PR bodies include
the invariants section from `docs/dev/review-pipeline.md`.

Common commands:

```bash
gt sync
gt add <files>
gt create -m "feat(symphony): add run repository"
gt modify
gt restack
gt submit --stack
```

## Review Loop

Do not treat automated review as a one-shot check.

Before opening or updating a PR:

```bash
bun run typecheck
bun run check:patterns:diff
bun run check:patterns
bun run test
bun run test:e2e
```

Then run the structured review pipeline:

1. Mechanical pattern sweep.
2. Trust-boundary sweep.
3. Atomicity and failure-mode review.
4. Runtime contract review for platform, VPS, containers, tunnels, or release
   changes.

For Greptile or equivalent automated PR review:

- Fix all CRITICAL and HIGH findings before merge.
- Continue the review/fix loop until Greptile reports 5/5.
- If a remaining finding is intentionally deferred, write the reason and follow-up
  issue in the PR body.
- Do not request deep review while still pushing unrelated commits. Freeze the
  review commit range or mark the PR ready and stop pushing.

## Development Environments

Matrix is a VPS-native product and should be built from Matrix. Local
development stays supported for focused tests and special cases, but it is not
the default daily workflow.

Use three environments deliberately:

| Environment | Purpose | Rule |
| --- | --- | --- |
| Personal dev VPS | Main engineering workspace: cloud coding, HMR, realistic shell/gateway behavior, Symphony, integrations, app previews | Default for daily Matrix development. |
| Shared dev VPS | Team dogfood, founder/operator smoke checks, reproductions that need shared state | Use when a bug depends on shared routing, auth, or operator setup. |
| Local source dev | Fast tests, mobile/desktop/native work, offline work, or special local infra | Use `bun run dev`, `bun run test`, focused package commands. Keep it secondary. |
| Production/customer VPS | What real users see | Observe and verify through release metadata, systemd health, logs, and app behavior. Do not edit code directly there. |

Production customer runtime ships only through host bundles. Do not deploy
customer-facing runtime changes by rebuilding Docker images, running Docker
Compose, or SSH-copying bundles except for documented break-glass recovery.

## Release Workflow

Choose the release target before merging:

| Target | Use for | Approval | How it ships |
| --- | --- | --- | --- |
| Personal dev VPS hot reload | Private engineering iteration | Engineer owning the VPS | Pull branch on dev VPS and run the dev-VPS compose/HMR flow. |
| Personal customer-like VPS | Final self-check of a host bundle | Engineer owning the VPS | Install a published `dev`/version with `matrix-update <channel-or-version>`. |
| Shared dev channel | Team dogfood after merge to `main` | PR merged, CI green, review loop clean | `main` workflow publishes host bundle to `dev`; operator can fan out to selected VPSes. |
| Canary/beta users | Early user validation | Engineering lead/operator approval | Promote tested version to `canary` or `beta`, then deploy selected users. |
| Stable users | Broad production rollout | Explicit release owner approval after canary/beta health | Promote version to `stable`, then deploy by channel or version. |
| Security hotfix | Urgent customer-facing fix | Release owner approval; can auto-deploy through security severity path | Build, publish, deploy, verify, and document rollback version. |

Main pushes build and register a host bundle, but do not automatically mean
"deploy to all users" unless the release workflow explicitly requests fan-out.
R2 stores immutable tarball bytes; platform Postgres is the source of truth for
release metadata and channel pointers.

Release to your own VPS:

```bash
matrix-update dev
matrix-update v2026.05.12-43
cat /opt/matrix/app/BUNDLE_VERSION
cat /opt/matrix/release.json
systemctl is-active matrix-gateway matrix-shell matrix-sync-agent
curl -fsS http://127.0.0.1:4000/health
```

Release to users:

1. Merge the reviewed PR or stack to `main`.
2. Watch the Host Bundle Release workflow.
3. Confirm the release row and channel pointer in platform metadata.
4. Deploy selected VPSes or the fleet through the platform:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/vps/deploy \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"channel":"dev"}'
   ```

5. Verify the fleet in Grafana and by sampling customer VPS health.
6. Promote to canary/beta/stable only after the previous channel is healthy.

Rollback:

```bash
matrix-update rollback
matrix-update stable
matrix-update v<known-good-version>
```

Never overwrite `/home/matrix/home`, `/opt/matrix/env`, or local Postgres data
during release or rollback. Host-bundle updates may replace `/opt/matrix/app`
only.

## Monitoring And Health

Primary production health is VPS-native:

- Grafana dashboard: VPS Fleet Overview.
- Prometheus metrics: `matrix_vps_info` and `matrix_vps_healthy`.
- Platform route: `GET /vps/:machineId/status` with `PLATFORM_SECRET`.
- Customer VPS services: `matrix-gateway`, `matrix-shell`, `matrix-code`,
  `matrix-sync-agent`, and local Postgres.
- Release files: `/opt/matrix/app/BUNDLE_VERSION` and
  `/opt/matrix/release.json`.

Useful checks:

```bash
systemctl is-active matrix-gateway matrix-shell matrix-code matrix-sync-agent
journalctl -u matrix-gateway -u matrix-shell -n 200 --no-pager
pg_isready --host=127.0.0.1 --username=matrix --dbname=matrix
curl -fsS http://127.0.0.1:4000/health
```

Legacy/local container dashboards and metrics still exist for old shared
container paths and Docker development:

- `platform_containers_total`
- `platform_container_cpu_percent`
- `platform_container_memory_bytes`
- `platform_container_memory_limit_bytes`
- `distro/monitor.sh`
- Grafana container detail dashboards

Do not use legacy container health as proof that production customer VPS runtime
is healthy. For production users, trust VPS fleet metrics, systemd service
health, customer gateway health, and browser behavior through `app.matrix-os.com`.

## Previewing UI Changes On A VPS

For shell/default-app/UI work:

1. Develop locally until focused tests pass.
2. Push or pull the branch on the engineer's dev VPS.
3. Start hot reload with the dev VPS compose flow in `docs/dev/dev-vps.md`.
4. Preview through authenticated Matrix routes, not an unauthenticated public
   dev server.
5. Use SSH port forwarding only for private raw dev ports:

   ```bash
   ssh -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 matrix@<dev-vps>
   ```

6. Verify Canvas first, then Desktop, then mobile if touched.
7. Capture screenshots or notes in the PR when the UI change is user-visible.

## Symphony Workflow

Symphony is the long-term operator surface for teams of coding agents:

1. Linear ticket is labeled and assigned to a Matrix project.
2. Symphony claims eligible work according to saved team/project/label rules.
3. Matrix creates or reuses the project worktree.
4. Matrix starts a Zellij-backed agent session with the repo workflow context.
5. The agent follows `AGENTS.md`, the spec plan, and the ticket.
6. Progress, retries, and terminal state are visible in Matrix.
7. The PR review loop runs until CI and Greptile converge.

Agents working inside Symphony should read the ticket, `AGENTS.md`,
`docs/dev/engineering-practices.md`, relevant specs, and the project
`WORKFLOW.md` before editing.

## Inngest Workflow

Use Inngest for durable website/control-plane workflows, not for every async
task. It is a good fit when a Clerk, Stripe, waitlist, billing, or email event
needs retries, `step.run(...)` persistence, `step.sleep(...)`, and operator
visibility.

Current Matrix use:

- `www/src/app/api/inngest/route.ts` serves Inngest functions.
- `www/src/inngest/provision-user.ts` handles `clerk/user.created`.
- It calls platform `/containers/provision`, which delegates to customer VPS
  provisioning when `CUSTOMER_VPS_ENABLED=true`.

Rules:

- Events and platform calls must be idempotent.
- Each step must be safe to retry.
- External calls need `AbortSignal.timeout(...)`.
- Capture start, delayed, failed, and completed states in PostHog.
- Keep platform/provider secrets in `www` or platform env only.
- Do not use Inngest for Symphony polling, customer VPS health checks, gateway
  request handlers, or owner-local automations.

## Access Checklist For Engineers

Minimum access:

- GitHub: repo read/write, PR review, Actions logs, package permissions if
  needed.
- Graphite: authenticated CLI for stacked PRs.
- Linear: project/team access and labels used by Symphony.
- Matrix dev VPS: SSH or Matrix-authenticated shell/code access.
- Anthropic: API key for local integration tests and agent work.

Conditional access:

- Hetzner: platform/customer VPS provisioning and recovery work only.
- Cloudflare: DNS, tunnels, R2, and cache behavior.
- Clerk: auth, session routing, and user provisioning.
- Vercel: `www/` and public docs deployment.
- npm/pnpm registry: publishing or dependency ownership work.
- Pipedream: platform-owned integration setup.
- Stripe: billing and entitlements.
- PostHog/Grafana: analytics, metrics, and production debugging.
- Telegram/WhatsApp/Discord/Slack provider consoles: channel adapter work.

Secrets stay in the platform or approved secret stores. Do not copy Clerk,
Pipedream, provider, or billing secrets into customer VPS env files, agent
configs, transcripts, PR comments, or screenshots.

For waitlist approval, provisioning retries, customer debugging, PostHog
monitoring, and outbound email planning, use `docs/dev/user-operations.md`.

## New Engineer Onboarding

Day 0:

- Grant GitHub, Linear, Graphite, Matrix dev VPS, and Anthropic access.
- Provision or assign a personal Matrix dev VPS with shell, code-server, Zellij,
  Claude/Codex/Hermes/Agent CLIs, and Matrix skills.
- Install Graphite CLI and GitHub CLI in the dev VPS.
- Clone the repo on the dev VPS, install with `pnpm install`, and run a focused
  smoke test such as `bun run check:patterns:diff`.
- Optionally install Node 24, pnpm 10, bun, and mobile/desktop toolchains
  locally for special cases.

Day 1:

- Read `AGENTS.md`, `.specify/memory/constitution.md`, `CONTEXT.md`, and this
  guide.
- Run Matrix on the dev VPS and confirm shell, gateway, code, and app previews.
- Run local setup only if the ticket needs local infrastructure such as native
  mobile, desktop, hardware, or offline work.
- Make a small docs or test-only PR through Graphite.

Week 1:

- Pair on one Spec Kit feature.
- Ship one small code PR with tests.
- Run the structured review pipeline and fix automated review comments.
- Preview one UI/runtime change on the dev VPS.

## Porting Other Startup Teams To Matrix

The same model should work for external teams:

1. Import their repos as Matrix projects.
2. Connect Linear/GitHub and configure Symphony ticket rules.
3. Create a per-engineer dev VPS with shell, code-server, Zellij, agent CLIs,
   and project secrets scoped to that engineer.
4. Add a repo-specific `AGENTS.md` and `WORKFLOW.md`.
5. Require Spec Kit for large changes and Graphite for stacked PRs.
6. Run automated review/fix loops until the PR is clean.
7. Use Matrix as the shared surface for planning, coding, previewing, and
   reviewing instead of local-only desktops.

The invariant is the same as Matrix OS itself: user and org data stay owned by
the team, agents operate with explicit context, and production changes flow
through reviewable releases.
