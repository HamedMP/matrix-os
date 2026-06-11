# Implementation Plan: Unified Onboarding State Machine and Signup-to-Ready Experience

**Branch**: `092-onboarding-unification` | **Date**: 2026-06-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/092-onboarding-unification/spec.md`

## Summary

Build a server-owned onboarding journey projection on the platform (`GET /api/journey`) that derives one phase per user (account → plan-required → payment-settling → provisioning → provisioning-failed → first-run → ready, with a degraded-readiness annotation) from existing sources of truth (`billing_entitlements`, `user_machines`, a new checkout-attempt record, a new server-side first-run record). Every surface — shell, www CTAs, mobile, CLI, macOS native — renders from this projection instead of re-deriving state. Ship the P1 reliability fixes first (stuck-provisioning reconciliation gaps, failed-row blocking, server-side payment settling, atomic machine replacement), then consolidate the shell into one boot-sequence flow, retire duplicate www auth pages, centralize origin/redirect construction, make readiness checks real, and extend the journey to CLI and mobile.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+; Swift 6 (macOS app, observe-only in this feature)
**Primary Dependencies**: Hono (platform/gateway), Next.js 16 + React 19 (shell, www), Kysely/Postgres (platform DB), Zod 4 via `zod/v4`, Clerk (identity), Stripe (billing), citty (CLI in `packages/sync-client`), Expo 55 / React Native (`apps/mobile`), Hetzner Cloud API (provisioning)
**Storage**: Platform PostgreSQL via Kysely — existing `user_machines`, `billing_entitlements`, `billing_customers`; new `billing_checkout_attempts`, `onboarding_first_run`, `onboarding_journey_events`. Inline migrations in `packages/platform/src/db.ts` `migrate()` (existing convention). VPS-local file `~/system/onboarding-complete.json` becomes a derived artifact, no longer the source of truth.
**Testing**: Vitest (`tests/platform/`, `tests/gateway/`, `tests/shell/`), Playwright e2e (`tests/e2e/onboarding-activation.spec.ts`, `onboarding-visual.spec.ts`); TDD red → green per constitution IX
**Target Platform**: Linux platform server (api.matrix-os.com), per-user Hetzner VPS (gateway/shell host services), browsers, iOS/Android (Expo), macOS, terminals
**Project Type**: Multi-package web monorepo (packages/platform, packages/gateway, packages/sync-client, shell/, www/, apps/mobile/, macos/)
**Performance Goals**: `/api/journey` p95 < 150 ms (single-user row lookups, no provider calls on the hot path); journey poll cadence 2–5 s during active phases without measurable platform load at beta scale
**Constraints**: Single platform instance (`setInterval` reconciler, `main.ts:4145` pattern) — no multi-instance coordination needed yet, but reconciliation writes must stay idempotent; never delete owner data on entitlement loss; `bodyLimit` + Zod validation on every new mutating route; no raw provider errors to clients
**Scale/Scope**: Paid-beta scale (hundreds of users); ~6 delivery phases, 3 new tables, 1 new public endpoint + 1 internal endpoint + 1 retry route, 1 new shell flow component, redirects in www, CLI + mobile journey rendering

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | Data Belongs to Its Owner | PASS | Journey state, checkout attempts, and machine lifecycle are platform-operational records (same class as existing `user_machines`/`billing_entitlements`). First-run completion is mirrored server-side for cross-device consistency; the owner-visible artifact `~/system/onboarding-complete.json` remains on the user's machine and is still written. No owner data is moved out of owner control; entitlement loss never deletes owner data (FR-015). |
| II | AI Is the Kernel | PASS | No kernel changes. The onboarding WS conversation (gateway) is untouched except stage annotation; journey is a routing/orchestration concern. |
| III | Headless Core, Multi-Shell | PASS | This feature *implements* the principle: one journey endpoint, five renderers. CLI and mobile become first-class journey consumers. |
| IV | Self-Healing | PASS | Reconciliation extension + settling self-heal are exactly this principle applied to provisioning/billing. |
| V | Quality Over Shortcuts | PASS | Boot sequence replaces three disjoint surfaces with one designed flow per spec 082 visual direction. |
| VIII | Defense in Depth | PASS | Auth matrix below; all new routes validated with Zod, `bodyLimit`, generic errors, timeouts on all external calls; return-path allowlist closes an open-redirect hole. |
| IX | TDD | PASS | Failing tests first per phase; existing suites extended (`tests/shell/billing-gate.test.tsx`, `tests/gateway/onboarding/*`, new `tests/platform/journey*.test.ts`). |
| X | Worktree, PR, Greptile 5/5 | PASS | This plan itself ships from worktree `092-onboarding-unification`; implementation PRs follow the same rule, split per delivery phase (PR size limits). |
| — | Docs-driven development | PASS | `www/content/docs/guide/getting-started.mdx`, `guide/cli.mdx`, `guide/mobile.mdx` updates are explicit tasks. |

### Auth Matrix (new/changed routes)

| Route | Method | Auth | Public? | Notes |
|-------|--------|------|---------|-------|
| `/api/journey` | GET | Clerk session cookie (web/mobile) OR sync JWT bearer (CLI/native) — same dual scheme as `/api/me` | No | Read-only projection; no body; rate-limited per user |
| `/api/journey/retry-provision` | POST | Same as `/api/journey` | No | `bodyLimit`; idempotent (converges on in-flight attempt per FR-028); 402 if entitlement missing |
| `/internal/first-run` | POST | `UPGRADE_TOKEN` (existing gateway→platform internal auth), constant-time compare | No | Gateway reports first-run completion/goal; Zod-validated payload |
| `/billing/checkout` | POST | Clerk session (existing) | No | Changed: records `billing_checkout_attempts` row; validates `returnPath` against allowlist |
| `/vps/register` | POST | Registration token (existing) | No | Changed: rejects retired/replaced/expired attempts (FR-010) |
| www `/signup`, `/login`, `/dashboard`, `/early-access` | GET | none | Yes | Become permanent redirects; no forms remain |

## Project Structure

### Documentation (this feature)

```text
specs/092-onboarding-unification/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── journey-api.md   # Phase 1 output — /api/journey, retry, internal first-run
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/platform/src/
├── journey.ts                  # NEW: phase derivation + journey events (FR-001..005, FR-029)
├── journey-routes.ts           # NEW: GET /api/journey, POST /api/journey/retry-provision
├── origins.ts                  # NEW: canonical origin authority + returnPath allowlist (FR-022/023)
├── customer-vps.ts             # CHANGED: reconciliation gaps, failed-row retirement, atomic replace
├── customer-vps-schema.ts      # CHANGED: provisioning stage on machine record
├── billing-routes.ts           # CHANGED: checkout-attempt recording, returnPath validation
├── billing.ts                  # CHANGED: settling-aware access decision
├── auth-routes.ts              # CHANGED: origin literals → origins.ts; device approval renders journey phase
├── main.ts                     # CHANGED: mount journey routes; reconciler covers token-expired case
└── db.ts                       # CHANGED: 3 new tables in migrate(); retire-failed transition helpers

packages/gateway/src/
├── onboarding/ws-handler.ts    # CHANGED: goal stage; report completion to platform via /internal/first-run
├── onboarding/readiness-service.ts  # CHANGED: real checks for launch-critical gates (FR-024)
└── routes/settings.ts          # CHANGED: onboarding-complete also posts to platform (transition period)

shell/src/
├── components/BootSequence.tsx # NEW: unified billing→settling→provisioning→first-run flow (FR-018)
├── hooks/useJourney.ts         # NEW: journey polling hook
├── components/BillingGate.tsx  # REMOVED (absorbed into BootSequence)
├── components/OnboardingScreen.tsx  # CHANGED: rendered as BootSequence final phase; goal step
└── components/Desktop.tsx      # CHANGED: first-run from journey, not /api/settings/onboarding-status

www/src/app/
├── signup/, login/, dashboard/, early-access/  # CHANGED: permanent redirects (FR-016/017)
└── (CTA components)            # CHANGED: point at app auth door via env-driven origin

packages/sync-client/src/cli/
├── commands/login.ts           # CHANGED: 404 dead-end → journey-aware guidance (FR-026)
└── commands/setup.ts           # NEW: trigger + watch provisioning from terminal

apps/mobile/
├── app/journey.tsx             # NEW: phase-appropriate screens (FR-027)
└── lib/gateway-client.ts       # CHANGED: journey fetch before assuming live gateway

tests/
├── platform/journey.test.ts            # NEW
├── platform/customer-vps-reconcile.test.ts  # NEW/EXTENDED
├── platform/billing-settling.test.ts   # NEW
├── shell/boot-sequence.test.tsx        # NEW (replaces billing-gate.test.tsx coverage)
├── gateway/onboarding/ws-handler.test.ts    # EXTENDED
└── e2e/onboarding-activation.spec.ts   # EXTENDED

www/content/docs/guide/
├── getting-started.mdx         # CHANGED
├── cli.mdx                     # CHANGED
└── mobile.mdx                  # CHANGED
```

**Structure Decision**: Follows the existing monorepo layout exactly — platform owns journey derivation and all new persistence (Kysely/Postgres, inline `migrate()` convention); gateway owns readiness and the first-run conversation; each surface gets only a renderer. No new packages: `origins.ts` lives in platform (server truth) with thin env-driven equivalents in shell/www where literals are removed, because a shared npm package for one function is unjustified complexity.

## Delivery Phasing (feeds tasks.md ordering)

Reliability ships before UX consolidation, per spec priorities. Each phase is an independently shippable PR (constitution X, PR size limits) and leaves main deployable.

- **Phase A — Provisioning & billing reliability (US2, US3 backend)**: reconciliation covers booted-but-never-registered machines (registration token expired ⇒ failed); `failed` rows stop blocking provision (retire-on-retry inside the provision transaction); attempt counter + bounded retry; stale `/vps/register` rejection; atomic replace in `recover()`; `billing_checkout_attempts` table + checkout route recording; settling-aware access decision. No UI change yet — BillingGate's existing poll simply stops lying.
- **Phase B — Journey core (US1)**: `journey.ts` derivation + `onboarding_journey_events` telemetry + `onboarding_first_run` table; `GET /api/journey`; `POST /api/journey/retry-provision`; gateway posts first-run completion via `/internal/first-run`; lazy backfill for legacy users.
- **Phase C — Shell boot sequence + readiness (US4, US7)**: `BootSequence.tsx` + `useJourney`; remove BillingGate; OnboardingScreen as final phase with goal step (spec 082 model); real readiness checks for launch-critical gates; degraded annotation surfaced post-ready.
- **Phase D — Page consolidation + origins (US5, US6)**: www auth pages → redirects; CTA sweep; `origins.ts` + returnPath allowlist; eliminate hardcoded origin literals in platform flow code (`request-routing.ts`, `auth-routes.ts`, `ws-upgrade.ts`, `billing-routes.ts`, `session-cookies.ts`) and www flow code.
- **Phase E — CLI + mobile (US8, US9)**: CLI journey-aware login + `matrix setup`; mobile journey screens.
- **Phase F — Docs + spec annotations**: public docs updates; annotate specs 053/082 per FR-020; PostHog journey-phase events wired to existing funnel dashboards.

## Complexity Tracking

> No constitution violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
