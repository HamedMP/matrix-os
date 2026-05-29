# Research: Paid Beta Readiness

## Decision: Reuse The Existing Onboarding Surface

**Decision**: Build launch activation onboarding by enhancing `shell/src/components/OnboardingScreen.tsx`, `shell/src/hooks/useOnboarding.ts`, and `packages/gateway/src/onboarding/*`.

**Rationale**: The repo already has a voice/text onboarding surface, state machine, WebSocket contract, API-key path, and completion marker. Extending it preserves the user journey, avoids competing first-run entry points, and keeps gateway validation/resource limits in one place.

**Alternatives considered**:

- Separate app under `home/apps/`: rejected because first-run setup needs shell-level control before apps/integrations are trusted.
- Platform-only onboarding page: rejected because launch readiness must continue inside the user VPS shell after provisioning.

## Decision: PR #162 Defines The Visual Baseline

**Decision**: First-run onboarding must align with the active website redesign in PR #162: calm stone/sage/forest palette, ember accent, refined typography, premium spacing, floating glass-like navigation/surfaces, real product media, always-on cloud-computer metaphor, and bring-your-own-agent education.

**Rationale**: The user explicitly called UI/UX "utmost importance" and asked to use Arian's onboarding/landing branding. The PR positions Matrix as a personal cloud computer with a preferred-agent setup path, which matches the paid-beta activation story.

**Alternatives considered**:

- Reuse the current sparse "Enter Matrix OS" voice-only screen: rejected because it does not handhold setup or educate users.
- Generic SaaS checklist wizard: rejected because it would undercut Matrix OS as a premium operating system.

## Decision: Goal-Based Setup Before Connector Prompts

**Decision**: Ask the user's first goal before showing connector steps. Supported first-run goals are coding with Matrix, building apps, setting up the company brain, and using Matrix as an assistant.

**Rationale**: Founders should understand why a connector is needed before they are asked to authorize it. This reduces setup fatigue and lets Matrix mark skipped workflows as degraded without blocking useful work.

**Alternatives considered**:

- Ask for every integration up front: rejected because it feels heavy and blocks users who only want one workflow.
- Hide integrations until first use: rejected because coding and assistant golden paths need guided readiness.

## Decision: Hermes Remains The Always-On System Agent

**Decision**: Claude remains the preferred core-agent path when available; Codex is optional coding support; Hermes remains the Matrix system agent in every credential state. Users without Claude must still be productive, and users who connect Claude or Codex must still be able to ask Hermes to build apps, complete approved operating tasks, use integrations, summarize context, and coordinate specialist agents.

**Rationale**: Paid beta cannot fail if a user lacks one provider credential, and it also cannot teach users that Matrix itself disappears once a third-party agent is connected. The onboarding app must be honest about available, coordinated, and degraded workflows while keeping Hermes as the stable system-agent identity.

**Alternatives considered**:

- Require Claude before onboarding completes: rejected because it blocks otherwise viable users.
- Replace Hermes with Claude/Codex after connection: rejected because Hermes must remain the agent of the Matrix system for app-building and operating tasks.
- Hide provider state from users: rejected because users need to understand which agent is powering work and what to connect next.

## Decision: Admin Control Surface Uses Finna Cloud As Product Pattern

**Decision**: Use `/home/deploy/finna-cloud` as inspiration for the Matrix admin/control surface that helps users connect models, configure settings, approve integrations, manage automations, and inspect activity/readiness.

**Rationale**: Finna Cloud already explores the operational UX Matrix needs for launch: provider/model cards with configured/unconfigured states, model search/filter, configuration editor with save/reload feedback, setup wizard session recovery, automation/Mission Control tabs, activity summaries, and reconnecting/status banners. Matrix should adapt those patterns into the PR #162 Matrix visual language instead of inventing a generic settings page.

**References reviewed**:

- `/home/deploy/finna-cloud/apps/web/src/components/gateway/models-page.tsx`
- `/home/deploy/finna-cloud/apps/web/src/components/gateway/config-page.tsx`
- `/home/deploy/finna-cloud/apps/web/src/components/gateway/mission-control-page.tsx`
- `/home/deploy/finna-cloud/apps/web/src/components/gateway/wizard-page.tsx`
- `/home/deploy/finna-cloud/apps/web/src/app/(dashboard)/dashboard/gateway-sidebar.tsx`
- `/home/deploy/finna-cloud/specs/003-channels-and-models/managed-models.md`
- `/home/deploy/finna-cloud/specs/003-channels-and-models/API-KEYS-STRATEGY.md`
- `/home/deploy/finna-cloud/specs/011-mission-control/README.md`

**Alternatives considered**:

- Treat model/settings/automation setup as separate forms: rejected because users need one coherent control surface during onboarding and after activation.
- Copy Finna UI directly: rejected because Matrix must keep the PR #162 brand system, Canvas-first shell conventions, and Matrix-specific agent/integration language.

## Decision: Owner-Scoped Readiness Checklist Is The Source Of Truth

**Decision**: Model readiness as an owner-scoped activation checklist covering provisioning, shell routing, Canvas, terminal, skills, agent credentials, Hermes system-agent continuity, Symphony, integrations, company brain, visual QA, and entitlement gates.

**Rationale**: The same state can drive the user-facing onboarding app and operator-facing readiness report. It also creates a single contract for retries and launch blocking.

**Alternatives considered**:

- UI-only checklist state: rejected because it cannot gate paid beta or support operator remediation.
- Separate operator report implementation: rejected because it would drift from the user experience.

## Decision: Approved Integration Capabilities And Safe Summaries

**Decision**: Calendar, email, repository, messaging, and publishing connections expose discrete approved capabilities to agents. Agent actions produce user-visible summaries and never return raw provider errors or secrets.

**Rationale**: This matches Matrix's defense-in-depth requirements and lets users trust Hermes/Claude/Codex actions such as adding calendar events, reading email, or updating work items.

**Alternatives considered**:

- Broad integration token access for agents: rejected because it is too risky for paid beta.
- Raw provider error display for debuggability: rejected because client-visible errors must be safe and generic.

## Decision: Visual QA Is A Launch Gate

**Decision**: Onboarding requires desktop and mobile visual QA, reduced-motion coverage, and evidence that text/actions do not overflow or overlap.

**Rationale**: The user's quality bar makes UI/UX a release criterion. Visual QA catches regressions that unit tests will not.

**Alternatives considered**:

- Manual design review only: rejected because it does not scale to later changes.
- Unit tests only: rejected because they cannot verify actual layout, media, or motion behavior.
