# Feature Specification: Unified Onboarding State Machine and Signup-to-Ready Experience

**Feature Branch**: `092-onboarding-unification`
**Created**: 2026-06-11
**Status**: Draft
**Input**: User description: "Unified onboarding state machine and world-class signup-to-ready experience. Collapse the fragmented signup → billing → provisioning → first-run journey into one server-owned onboarding state machine exposed via a single platform endpoint that every surface (www, desktop shell, mobile, CLI, native app) renders from. Fix the top reliability failures, collapse duplicate pages, declare spec 082 the canonical onboarding UX, make readiness checks real, and extend the same state machine to CLI and mobile."

## Context

Today a new user crosses four independently owned gates between "I signed up" and "I am using my Matrix computer": account sync, the billing wall, machine provisioning, and the first-run experience. Each gate is checked by a different component with its own polling, error handling, and redirect logic, and no component knows the whole journey. The observable symptoms are: users permanently stuck on "provisioning", the paywall re-appearing right after a successful payment, recurring redirect/origin bugs (three hotfix commits in the last week alone), five separate sign-in/sign-up surfaces, a readiness checklist that mostly reports "unknown", a CLI that dead-ends new users, and a mobile app that breaks for any user without a running machine.

This feature establishes one server-owned journey state for every user and makes every surface a renderer of that state, then fixes the reliability failures that the fragmentation has been masking.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One Journey State, Rendered Everywhere (Priority: P1)

As a user on any surface (web shell, mobile, CLI, native app), whenever I open Matrix OS I am placed at exactly the step of the journey I am actually at — needs account, needs plan, payment settling, computer being built, computer failed and can be retried, first-run setup, or ready — with one clear next action. I never see a wall for a step I have already completed and never see a "ready" surface for a machine that does not exist.

**Why this priority**: This is the keystone. Every other fix (billing race, stuck provisioning, page sprawl) either depends on a single source of truth for journey state or is a workaround for its absence. Without it, each surface keeps re-deriving journey state from partial signals and the class of bugs recurs.

**Independent Test**: For a test user placed in each journey phase (no entitlement, entitlement pending, entitlement active with no machine, machine provisioning, machine failed, machine running with first-run incomplete, fully ready), query the journey-state endpoint and load the web shell. The reported phase, the suggested next action, and the rendered screen must match the user's true state in all seven cases.

**Acceptance Scenarios**:

1. **Given** a signed-in user with an active plan and a machine mid-provisioning, **When** they open the web shell, **Then** they see the provisioning progress step — not the billing wall and not a broken desktop.
2. **Given** a signed-in user whose machine is running but who has not completed first-run setup, **When** they open the shell on a second device, **Then** both devices show the first-run step, because journey state is owned by the server and not by a per-device marker.
3. **Given** any journey phase, **When** a surface queries the journey-state endpoint, **Then** the response identifies the current phase, a human-readable status detail, and the single next action the surface should offer.
4. **Given** a user whose journey state changes (e.g. provisioning completes) while a surface is open, **Then** the surface reflects the new phase without requiring a manual page reload.

---

### User Story 2 - Provisioning Never Strands a User (Priority: P1)

As a user whose machine creation fails or hangs (cloud provider error, boot script failure, registration window expiry), I see an honest failure state with a one-click "Retry setup" that works — instead of an infinite spinner today and a permanently blocked account tomorrow.

**Why this priority**: A stuck `provisioning` record currently never times out and permanently blocks re-provisioning for that user (the active-machine uniqueness rule treats the zombie row as the active machine). This is the most severe failure in the funnel: it loses a paying customer at the moment of highest intent, with no self-service recovery.

**Independent Test**: Force a provisioning record to remain unregistered past the timeout. Verify it transitions to a failed state automatically, the user sees the failure with a retry action, retrying succeeds, and exactly one machine ends up active.

**Acceptance Scenarios**:

1. **Given** a machine record stuck in provisioning past the provisioning timeout, **When** the reconciliation pass runs, **Then** the record is marked failed, the user's active-machine slot is freed, and the journey state moves to a retryable failure phase.
2. **Given** a user viewing the failure phase, **When** they choose "Retry setup", **Then** a new provisioning attempt starts and its live progress is shown, without operator intervention.
3. **Given** a provisioning attempt in progress, **When** the user waits, **Then** the surface shows real stage-level progress (server created → booting → registering → ready) rather than an indefinite spinner, and the wait state never silently expires client-side while the server is still working.
4. **Given** a machine recovery or retry that replaces an old machine, **When** the replacement activates, **Then** at no point are two machines simultaneously routable for the same user — the old machine is retired and the new one activated as one atomic transition.
5. **Given** repeated provisioning failures, **Then** the user sees an escalation path (contact/support affordance) after a bounded number of automatic retries, not an endless retry loop.

---

### User Story 3 - Payment Activates Without Re-Showing the Paywall (Priority: P1)

As a user who just completed checkout, I return to the app and see "Activating your subscription…" followed automatically by my machine being set up. I never see the billing wall again after paying, even if the payment provider's confirmation takes time to arrive.

**Why this priority**: The checkout-success/webhook race re-shows the paywall to users who just paid — the single most trust-destroying moment possible in a paid product. It is also a leading source of "it broke" reports.

**Independent Test**: Simulate a checkout completion whose entitlement confirmation arrives N seconds later (for N up to several minutes). Verify the user sees a settling state the whole time, transitions to provisioning automatically when the entitlement lands, and sees a clear path (with support escalation) if confirmation never arrives within the settling window.

**Acceptance Scenarios**:

1. **Given** a user returning from successful checkout before the entitlement is recorded, **When** the shell loads, **Then** they see a payment-settling state, not the billing wall.
2. **Given** the settling state, **When** the entitlement is recorded, **Then** the journey advances automatically into provisioning without user action.
3. **Given** an entitlement that has not arrived within the maximum settling window, **Then** the user sees an explicit "taking longer than expected" state with a support action — never a silent fallback to the paywall.
4. **Given** a user who abandons checkout, **When** they return, **Then** they see the plan selection step again, unchanged.

---

### User Story 4 - One Continuous Boot Sequence (Priority: P2)

As a new user, after signing in I experience signup → plan → payment → machine build → first-run setup as one continuous, designed flow on a single surface — a "your computer is being built" sequence with live progress — instead of three visually and behaviorally unrelated experiences (billing modal, anonymous spinner, separate onboarding screen).

**Why this priority**: This is the world-class UX payoff, but it requires US1's state machine to exist first. It directly addresses "too many pages": the billing gate, provisioning poll, and first-run screen merge into one progressive experience.

**Independent Test**: Walk a brand-new account from first sign-in to ready desktop. The entire journey happens within one coherent flow (no full-context jumps between unrelated screens), each phase shows meaningful progress, and the final transition lands in the working shell.

**Acceptance Scenarios**:

1. **Given** a brand-new signed-in user, **When** they proceed through plan selection, payment, machine build, and first-run, **Then** every step renders within the same flow with consistent visual language and a visible sense of progression.
2. **Given** the machine-build phase, **When** provisioning advances through its stages, **Then** the user sees the live stage progression as a designed moment (the wait is informative, not a spinner).
3. **Given** the first-run phase, **When** it begins, **Then** the goal-based setup defined by spec 082 is offered (choose a goal; conversational/voice setup optional; AI-agent credential connection optional with the system agent always available) — superseding the older required-API-key onboarding stage.
4. **Given** a returning user who is fully ready, **When** they sign in, **Then** they bypass the boot sequence entirely and land in the shell directly.
5. **Given** a user who exits mid-boot-sequence (closes the tab during any phase), **When** they return on any surface, **Then** they resume at the same phase.

---

### User Story 5 - One Auth Door, No Legacy Pages (Priority: P2)

As a visitor coming from the marketing website, every call-to-action takes me to a single sign-in/sign-up door for the app. The website no longer hosts its own duplicate signup and login pages, and legacy entry pages (early-access waitlist, dead dashboard redirect) are gone. Old URLs still work via redirects.

**Why this priority**: Five auth surfaces with two different configurations is a standing source of redirect bugs and inconsistent post-auth behavior. Consolidation shrinks the broken-page surface immediately and is independently shippable.

**Independent Test**: Crawl all marketing-site CTAs and the retired URLs. Every auth-related path resolves to the single app auth door; no page presents a second sign-up form; retired URLs redirect rather than 404.

**Acceptance Scenarios**:

1. **Given** the marketing site, **When** any sign-up/sign-in/get-started CTA is followed, **Then** the visitor lands on the single app auth door.
2. **Given** the retired website signup, login, early-access, and dashboard URLs, **When** visited directly (including from old emails and bookmarks), **Then** the visitor is redirected to the appropriate live destination with no error page.
3. **Given** a successful sign-in at the auth door, **Then** the user enters the journey at their correct phase per US1 — new users into the boot sequence, ready users into the shell.

---

### User Story 6 - Redirects That Never Break (Priority: P2)

As a user, sign-in, checkout return, device authorization, and app-session handoffs always land me on the correct origin and path, in every environment (production, staging, local development), with no redirect loops and no possibility of being bounced to an attacker-supplied destination.

**Why this priority**: Origin/redirect construction is currently scattered across surfaces with ~30 hardcoded production URLs and several header-derived fallbacks; the last three production hotfixes were all symptoms of this class. One canonical origin/return-path authority eliminates the class.

**Independent Test**: Exercise sign-in, checkout return, and session handoff in production-like and staging-like configurations. All redirects resolve to the configured canonical origin; a tampered return-path pointing off-allowlist is rejected and falls back to the safe default.

**Acceptance Scenarios**:

1. **Given** any environment configuration, **When** an auth, billing, or session flow constructs a redirect, **Then** the destination origin comes from the single canonical-origin authority, not from hardcoded literals or request-header guesses.
2. **Given** a return-path parameter supplied or influenced by a client, **When** the redirect is constructed, **Then** the path is validated against an allowlist and any off-allowlist value falls back to the default landing destination.
3. **Given** a staging or development deployment, **When** the full signup-to-ready journey runs, **Then** no step redirects to the production origin.

---

### User Story 7 - Honest Readiness (Priority: P3)

As a user finishing first-run, the readiness checklist reflects the real verified state of my system — workspace reachable, shell routed, terminal alive, skills loaded, agent credentials valid — instead of placeholder "unknown" for nearly every item. As an operator, I can trust the same checklist to decide whether a user's environment is actually healthy.

**Why this priority**: Valuable for trust and supportability, but depends on the journey being reliable first. A beautiful checklist over a broken funnel helps nobody.

**Independent Test**: For a healthy machine, all readiness checks report pass with evidence. Break each checked subsystem one at a time and verify the corresponding check (and only it) reports a failure with an actionable description.

**Acceptance Scenarios**:

1. **Given** a fully provisioned healthy machine, **When** readiness is evaluated, **Then** every launch-critical check reports a verified pass — none report "unknown".
2. **Given** a machine with one broken subsystem, **When** readiness is evaluated, **Then** that check fails with a human-actionable explanation and the journey state reflects degraded readiness without blocking unrelated workflows.
3. **Given** the always-available system agent, **Then** its readiness is verified by an actual liveness signal, not hardcoded as passing.

---

### User Story 8 - CLI Joins the Same Journey (Priority: P3)

As a developer signing in from the terminal, if my account has no machine yet, the CLI tells me my actual journey phase and can carry me forward — directing me through plan selection if unpaid, or triggering and watching provisioning if entitled — instead of today's dead-end "no instance found, go to the website".

**Why this priority**: Developers are the first ICP; the CLI dead-end breaks the strongest acquisition channel. Depends on US1's endpoint.

**Independent Test**: Run CLI login as (a) a user with no plan, (b) an entitled user with no machine, (c) a user with a ready machine. Each case reports the correct phase; case (b) can provision to completion entirely from the terminal.

**Acceptance Scenarios**:

1. **Given** an entitled user with no machine, **When** they sign in via CLI, **Then** the CLI offers to set up their computer, streams stage-level progress, and ends connected to the ready machine.
2. **Given** a user with no plan, **When** they sign in via CLI, **Then** the CLI states the plan-selection step is needed and provides the exact link to continue — a guided handoff, not an error.
3. **Given** a provisioning failure during a CLI-initiated setup, **Then** the CLI surfaces the same retryable failure state as the web (US2), with a retry command.

---

### User Story 9 - Mobile Renders the Journey (Priority: P3)

As a mobile user, signing in on a fresh account (or while my machine is provisioning/failed) shows me the correct journey phase with appropriate actions, instead of the app assuming a running machine exists and failing opaquely.

**Why this priority**: Same dependency on US1; smaller current audience than CLI but the failure today is a hard crash-equivalent for any not-fully-onboarded user.

**Independent Test**: Sign in on mobile as users in each pre-ready phase. Each shows a phase-appropriate screen; none shows a connection error or blank shell.

**Acceptance Scenarios**:

1. **Given** a mobile user with no entitlement, **When** they sign in, **Then** they see the plan step with a handoff to complete payment (in-app browser or link), and the app advances automatically once entitlement lands.
2. **Given** a mobile user whose machine is provisioning, **Then** the app shows live build progress and transitions to the shell when ready.
3. **Given** a mobile user whose machine is in a failed state, **Then** the app shows the retryable failure state from US2.

---

### Edge Cases

- **Entitlement expires or is revoked mid-provisioning**: the machine build completes or aborts cleanly, the journey moves to the plan-required phase, and the user's data is never deleted (consistent with the billing data-safety invariant).
- **Provider confirmation never arrives** (webhook outage): settling state escalates to support after the maximum window; once the entitlement is later recorded, the journey self-heals on next load.
- **Two surfaces act simultaneously** (e.g. web and CLI both trigger setup): exactly one provisioning attempt proceeds; the other surface observes it instead of starting a duplicate.
- **Journey-state endpoint unavailable**: surfaces show a clear "can't reach Matrix" state with retry — they do not guess a phase, and they never render a paywall or a destroy-capable action on stale data.
- **User with a pre-existing machine from the legacy flow**: journey derivation classifies them correctly as ready (or degraded) without forcing them back through billing or first-run.
- **First-run marker exists but machine was rebuilt from backup**: journey state derives first-run completion from server-owned state, surviving machine replacement.
- **Stale or replayed provisioning callbacks**: registration of an already-failed or already-replaced machine attempt is rejected and cannot resurrect a retired record.
- **Clock skew / long-running settling**: all timeout windows are evaluated server-side so client clocks cannot prematurely expire or extend a phase.
- **User deletes account mid-journey**: in-flight provisioning is cancelled and any created machine is reaped; no orphan resources accrue billing cost.

## Requirements *(mandatory)*

### Functional Requirements

**Journey state (single source of truth)**

- **FR-001**: The platform MUST own a single per-user onboarding journey state derived from account, billing entitlement, machine lifecycle, and first-run completion — with exactly one current phase per user at any time, drawn from a fixed published set (at minimum: account-required, plan-required, payment-settling, provisioning, provisioning-failed, first-run, ready, plus a degraded-readiness annotation).
- **FR-002**: The platform MUST expose the journey state to authenticated clients through one endpoint that returns the current phase, a human-readable detail, the single recommended next action, and (during provisioning) stage-level progress.
- **FR-003**: All five surfaces (web shell, marketing-site CTAs, mobile, CLI, native app) MUST derive what they render from the journey state rather than independently re-checking billing, machine, or first-run signals.
- **FR-004**: Journey phase transitions MUST be observable by an open surface in near-real-time (push or efficient poll) so the user advances without manual reloads.
- **FR-005**: First-run completion MUST be recorded in server-owned state so it survives machine replacement and is consistent across devices; any existing per-machine marker becomes a derived artifact, not the source of truth.

**Provisioning reliability**

- **FR-006**: Machine records in a provisioning state MUST automatically transition to a failed state when they exceed a provisioning timeout, via a recurring server-side reconciliation that requires no operator action.
- **FR-007**: A failed machine record MUST NOT block the user from starting a new provisioning attempt; the active-machine uniqueness rule applies only to live machines.
- **FR-008**: Users MUST be able to retry a failed provisioning themselves from any surface, with a bounded automatic-retry policy and an explicit support escalation after repeated failures.
- **FR-009**: Machine replacement (retry, recovery, upgrade) MUST retire the old machine and activate the new one as a single atomic transition; at no observable moment are two machines routable for one user.
- **FR-010**: Provisioning callbacks/registrations for retired, replaced, or expired attempts MUST be rejected.
- **FR-011**: Failed and replaced machines MUST be reaped at the cloud provider within a bounded window so abandoned attempts do not accrue cost.

**Billing settling**

- **FR-012**: After a user returns from a completed checkout, the journey MUST enter a payment-settling phase until the entitlement is recorded; during settling the billing wall MUST NOT be shown.
- **FR-013**: When the entitlement is recorded, the journey MUST advance automatically (settling → provisioning) without user action.
- **FR-014**: If the entitlement is not recorded within a maximum settling window, the user MUST see an explicit delayed-confirmation state with a support action; the system MUST self-heal when the entitlement later arrives.
- **FR-015**: Loss of entitlement MUST block new provisioning and MAY suspend access, but MUST never delete or overwrite owner data.

**Page consolidation**

- **FR-016**: The marketing website MUST NOT host its own sign-up or sign-in forms; all auth CTAs MUST lead to the single app auth door, and the retired website auth URLs MUST redirect there.
- **FR-017**: The legacy early-access and dashboard pages MUST be retired with redirects to their live equivalents; no onboarding-era URL may return a 404.
- **FR-018**: The web shell's billing gate, provisioning wait, and first-run screen MUST be unified into one continuous boot-sequence flow rendered from the journey state, with consistent visual language and resumability at every phase.
- **FR-019**: A fully ready returning user MUST bypass the boot sequence and land directly in the shell.

**Canonical onboarding UX**

- **FR-020**: The first-run experience MUST follow the goal-based model of spec 082 (choose a goal; system agent always available; AI-provider credential connection optional; conversational/voice setup offered, not required), and spec 053's required-API-key stage is formally superseded. Spec documents for 053 and 082 MUST be annotated accordingly.
- **FR-021**: Each optional first-run step MUST state what it unlocks and the consequence of skipping, separated into required / recommended / optional (per spec 082 FR-008/FR-009).

**Origin and redirect integrity**

- **FR-022**: All server- and client-side construction of auth, billing-return, device-authorization, and session-handoff URLs MUST resolve the origin through one canonical-origin authority configured per environment; hardcoded production origins in flow code MUST be eliminated.
- **FR-023**: Any client-influenced return path MUST be validated against an allowlist before use in a redirect; off-allowlist values fall back to the default destination.

**Readiness**

- **FR-024**: Every launch-critical readiness check MUST be backed by a real verification (no hardcoded pass and no perpetual "unknown" for implemented subsystems), and each failing check MUST carry a human-actionable explanation.
- **FR-025**: Degraded readiness MUST be expressed as an annotation on the ready phase — it informs the user and operator but does not re-block completed journey phases.

**Cross-surface**

- **FR-026**: CLI sign-in MUST report the user's journey phase; for entitled users with no machine it MUST be able to trigger provisioning and stream stage-level progress to completion; for unpaid users it MUST hand off to the plan step with an exact continuation link.
- **FR-027**: Mobile MUST render phase-appropriate screens for every pre-ready phase (plan, settling, provisioning, failed, first-run) and advance automatically on phase transitions.
- **FR-028**: Concurrent setup attempts from multiple surfaces MUST converge on a single provisioning attempt; secondary surfaces observe rather than duplicate it.

**Observability & operations**

- **FR-029**: Every journey phase transition MUST be recorded with timestamps so funnel drop-off and time-in-phase are measurable per user and in aggregate.
- **FR-030**: Operators MUST be able to view a user's current journey state, phase history, and machine lifecycle history when handling support, and the reconciliation process MUST log every automatic state correction it applies.

### Key Entities

- **Onboarding Journey**: per-user derived state — current phase, phase entered-at, detail, recommended next action, readiness annotation. The single truth all surfaces render.
- **Machine Lifecycle Record**: a user's machine attempt — states spanning requested, provisioning (with stage), running, failed, retired, reaped; carries timestamps, failure reason, and attempt counter. Exactly one live record per user.
- **Billing Entitlement**: the recorded right to run machines (plan, status, period); derived from payment-provider events; consumed (never written) by journey derivation.
- **Settling Window**: the bounded period between checkout completion and entitlement recording, during which the journey reports payment-settling.
- **Readiness Check**: a named verification with result (pass/fail/unknown-with-reason), evidence, and actionable failure description; aggregated into the readiness annotation.
- **First-Run Completion**: server-owned record of first-run setup (goal chosen, steps completed/skipped), independent of any one machine's disk.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user completes signup → payment → built machine → ready desktop in under 5 minutes (p50) and under 10 minutes (p95), measured from journey telemetry.
- **SC-002**: Zero users remain in a provisioning phase longer than the provisioning timeout without automatic transition to failed-with-retry; the count of accounts permanently blocked from provisioning is zero.
- **SC-003**: Zero post-payment paywall reappearances: no user with a completed checkout is shown the billing wall again (excluding genuine entitlement loss).
- **SC-004**: Auth/onboarding page surfaces are reduced from five sign-in/sign-up entry pages to one, and all retired onboarding-era URLs redirect with zero 404s.
- **SC-005**: Production incidents in the redirect/origin class (wrong origin, redirect loop, off-environment bounce) drop to zero in the 60 days after release, versus three hotfixes in the preceding period.
- **SC-006**: 100% of launch-critical readiness checks report verified pass/fail on healthy and deliberately broken machines respectively; "unknown" appears only for genuinely unprovisionable subsystems.
- **SC-007**: CLI sign-in for a machine-less user results in a completed setup or an exact guided handoff in 100% of cases — zero dead-end errors.
- **SC-008**: Mobile sign-in renders a correct phase-appropriate screen for 100% of pre-ready journey phases with no blank or error states.
- **SC-009**: Funnel telemetry can report per-phase conversion and median time-in-phase for every phase of the journey.
- **SC-010**: Onboarding-related support tickets (stuck setup, paywall-after-payment, broken links/redirects) decrease by at least 70% within 60 days of release.

## Assumptions

- **Spec 082 is canonical for first-run UX**; spec 053's voice flow survives as an optional mode inside the 082 goal-based experience, and its required-API-key stage is superseded. Spec 012 (persona onboarding) remains parked and is out of scope.
- **Provisioning remains eager-after-entitlement** (machine build starts once a plan is active), matching current platform behavior; spec 070's lazy-provisioning note is superseded for paid users by this flow.
- **Stripe remains the billing provider** per spec 084; this feature consumes entitlements and does not change plan catalogs, pricing, or checkout mechanics beyond the return/settling experience.
- **Retired website auth pages redirect rather than disappear**: existing emails, docs, and bookmarks must keep working.
- **The journey-state endpoint is an addition to the platform's existing authenticated API surface**, using existing session auth for web/mobile and existing device-flow tokens for CLI/native; no new auth scheme is introduced.
- **Channel adapters (Telegram, etc.) are out of scope** for this feature; spec 077 owns channel pairing.
- **Operator-facing journey visibility** reuses the existing admin/control surface direction from spec 082 (FR-016 there); this feature requires the data and a minimal view, not a full admin redesign.
- **No trial plans exist** during paid beta (per spec 084), so the journey has no trial-specific phases.
