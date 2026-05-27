# Implementation Plan: Paid Beta Readiness

**Branch**: `082-paid-beta-readiness` | **Date**: 2026-05-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/082-paid-beta-readiness/spec.md`

## Summary

Make Matrix OS paid-beta ready for technical founders and developers by shipping a premium first-run onboarding app, goal-based setup, always-on Hermes system-agent routing with Claude/Codex augmentation, GitHub-first coding activation, approved assistant integrations, company-brain workflows, Finna-inspired admin/control surfaces, and operator readiness gates before Clerk payments are enabled. The onboarding UX must follow the active Matrix website redesign in PR #162: calm stone/sage/forest palette, ember accent, refined typography, polished motion, real product proof, always-on cloud-computer framing, and bring-your-own-agent education.

The implementation extends the existing shell onboarding surface (`shell/src/components/OnboardingScreen.tsx`, `shell/src/hooks/useOnboarding.ts`) and gateway onboarding contracts (`packages/gateway/src/onboarding/*`) instead of creating a parallel onboarding stack. Shared readiness state and route contracts live in the gateway; Symphony, integrations, terminal, skills, and platform provisioning expose status into a single activation model. Visual QA, no-Claude Hermes operation, and Hermes continuity while Claude/Codex are connected are launch-blocking gates.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16 shell/platform, Hono gateway  
**Primary Dependencies**: Hono, Zod 4 via `zod/v4`, Kysely/Postgres, existing onboarding WebSocket, existing Symphony routes, existing integrations registry/Pipedream proxy, existing terminal stack, lucide-react, Playwright/Vitest  
**Storage**: Owner-controlled Postgres/Kysely for readiness, integration capability, agent action, company context, and audit data; owner home files for inspectable onboarding completion/profile/config exports under `~/system/`; no new embedded database or ORM  
**Testing**: Vitest for unit/contract/integration tests; Playwright for shell onboarding visual/golden-path QA; pattern scanner via `bun run check:patterns`; full gates via `bun run typecheck`, `bun run test`, and targeted e2e/visual checks  
**Target Platform**: Matrix OS web shell on per-user VPS runtime, platform provisioning routes, gateway HTTP/WS APIs, desktop and mobile browser viewports  
**Project Type**: Web application plus gateway/platform backend in the existing monorepo  
**Performance Goals**: First-run onboarding interactive within 2 seconds after shell load; readiness polling p95 under 500ms from the user VPS gateway; golden-path signup-to-ready under 15 minutes; GitHub/project selection to next action under 5 minutes after workspace readiness  
**Constraints**: Canvas-first shell behavior; no wildcard CORS; body limits on all mutating endpoints; all external provider calls have timeout signals; provider secrets/raw errors never reach clients; no unbounded in-memory collections; reduced-motion fallback for branded animation; responsive layouts with no cropped/overlapping text  
**Scale/Scope**: One paid-beta founder/developer workspace must pass fresh and existing workspace rehearsals; design must support future org/team expansion without implementing enterprise administration in this feature

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status | Notes |
|-----------|------|--------|-------|
| Data Belongs to Its Owner | User/company context, credentials, and readiness state have explicit owner scope and exportable summaries | PASS | Use owner Postgres for operational data and owner home files for inspectable setup/config markers. Preserve owner data when entitlement changes. |
| AI Is the Kernel | Agent setup routes through Matrix agent model with always-on Hermes and Claude/Codex augmentation | PASS | Claude powers the current core agent path when available; Hermes remains fully functional before and after Claude/Codex connection; Codex is optional coding support. |
| Headless Core, Multi-Shell | Readiness/status is gateway-owned and shell-rendered | PASS | Onboarding UI is one renderer; readiness contracts remain usable by CLI/channel shells later. |
| Self-Healing and Self-Expanding | Retry/recovery paths are required for provisioning, credentials, and integrations | PASS | User-facing recovery must avoid SSH/database intervention. |
| Quality Over Shortcuts | Premium onboarding UX is a launch gate | PASS | PR #162 branding is an explicit baseline; visual QA is required before paid beta. |
| App Ecosystem | Hermes-assisted app building is in scope with permissioned skills | PASS | App-building guidance uses existing skills/app runtime; broad app store launch remains out of scope. |
| Multi-Tenancy | Personal owner scope first, authorized teammates only | PASS | Org-wide enterprise admin is deferred. |
| Defense in Depth | Auth matrix, input validation, body limits, timeouts, generic errors, audit summaries | PASS | Contracts include route-level auth/error/body-limit expectations. |
| TDD | Tests first for route contracts, state derivations, no-Claude path, connected-agent Hermes continuity, admin control surface, visual QA | PASS | Tasks require failing tests before implementation. |

**Post-Design Recheck**: PASS. Phase 1 artifacts keep owner-scoped state, route-boundary validation, generic client errors, no raw provider errors, and explicit visual QA as launch gates.

## Project Structure

### Documentation (this feature)

```text
specs/082-paid-beta-readiness/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── onboarding-readiness.md
└── tasks.md
```

### Source Code (repository root)

```text
shell/src/
├── components/
│   ├── OnboardingScreen.tsx
│   └── onboarding/
│       ├── AdminControlPanel.tsx
│       ├── AdminSetupWizard.tsx
│       ├── ApiKeyInput.tsx
│       ├── AppSuggestionCards.tsx
│       ├── ContentDisplay.tsx
│       ├── DesktopMockup.tsx
│       ├── ProfileInfoPanel.tsx
│       ├── VoiceOrb.tsx
│       └── VoiceWave.tsx
├── hooks/
│   └── useOnboarding.ts
└── app/page.tsx

packages/gateway/src/
├── onboarding/
│   ├── activation-contracts.ts
│   ├── activation-errors.ts
│   ├── admin-control-routes.ts
│   ├── admin-control-service.ts
│   ├── agent-credential-routes.ts
│   ├── agent-credential-status.ts
│   ├── types.ts
│   ├── state-machine.ts
│   ├── ws-handler.ts
│   └── api-key.ts
├── integrations/
│   ├── registry.ts
│   ├── routes.ts
│   └── types.ts
├── symphony/
│   ├── contracts.ts
│   ├── routes.ts
│   └── orchestrator.ts
├── routes/settings.ts
├── system-info.ts
└── server.ts

packages/platform/src/
├── main.ts
├── launch-readiness.ts
├── launch-readiness-routes.ts
├── customer-vps.ts
├── customer-vps-routes.ts
└── profile-routing.ts

tests/
├── gateway/
│   ├── onboarding-activation.test.ts
│   ├── activation-readiness-routes.test.ts
│   ├── admin-control-routes.test.ts
│   ├── integrations-routes.test.ts
│   └── symphony-workflow.test.ts
├── kernel/
│   └── onboarding.test.ts
├── platform/
│   ├── launch-entitlement.test.ts
│   ├── launch-readiness.test.ts
│   └── proxy-routing.test.ts
└── e2e/
    ├── onboarding-activation.spec.ts
    └── onboarding-visual.spec.ts

www/content/docs/
└── onboarding-launch-readiness.mdx
```

**Structure Decision**: Implement as an incremental shell + gateway + platform feature in existing Matrix OS surfaces. The shell owns the beautiful onboarding experience; the gateway owns readiness state, integration status, agent credential status, and safe action summaries; the platform continues to own provisioning/routing/entitlement gates. Tests live in existing `tests/` suites so root Vitest and Playwright workflows discover them.

## Phase 0: Research

Research output: [research.md](./research.md)

Key decisions resolved:

- Reuse the current onboarding surface and progressively enhance it.
- Treat PR #162 website redesign as the visual baseline for first-run onboarding.
- Model readiness as an owner-scoped activation checklist rather than scattered UI-only booleans.
- Support Claude, Codex, and Hermes as user-visible agent modes with Hermes as the always-on Matrix system agent.
- Use `/home/deploy/finna-cloud` as admin/control-surface inspiration for provider cards, model setup, configuration save/reload, setup wizard recovery, automation tabs, activity feeds, and mission-control operations.
- Route integrations through approved capabilities and safe action summaries.
- Make visual QA, no-Claude Hermes path, connected Claude/Codex plus Hermes continuity, and golden-path coding handoff launch-blocking checks.

## Phase 1: Design & Contracts

Design outputs:

- [data-model.md](./data-model.md)
- [contracts/onboarding-readiness.md](./contracts/onboarding-readiness.md)
- [quickstart.md](./quickstart.md)

Interface strategy:

- Extend onboarding WebSocket schema for goal selection, readiness updates, agent credential states, and branded content panels.
- Add/extend owner-authenticated gateway endpoints for activation checklist reads, setup goal persistence, readiness retry, agent credential status, and integration capability approval.
- Keep provider-specific details server-side. Browser-visible responses use generic status/error codes and action-oriented copy.
- Readiness gates are composable so operator reports can reuse the same state as the user onboarding checklist.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Multi-surface delivery across shell, gateway, platform, docs, and e2e | Paid beta readiness spans first-run UX, runtime status, integrations, agent routing, provisioning, and entitlement gates | A shell-only wizard would look complete while leaving broken backend/runtime states invisible |
| PR #162 visual alignment as a hard gate | User explicitly made UI/UX utmost importance and requested that branding | Treating UI as polish would allow a functional but non-premium onboarding to pass planning |
