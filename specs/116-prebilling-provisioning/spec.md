# Feature Specification: Prebilling Provisioning

**Feature Branch**: `116-prebilling-provisioning`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "Move VPS provisioning earlier in onboarding so Matrix starts preparing the user's selected computer before billing completes, after the user has chosen compute power, region, and coding agents."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prepare While the User Checks Out (Priority: P1)

A newly signed-in user chooses their computer power, region, and default coding agents before billing. When they explicitly continue to secure checkout, Matrix begins preparing that exact computer while the user completes checkout. After billing is confirmed, the user continues into an already-ready or nearly-ready computer instead of starting the build from zero.

**Why this priority**: Provisioning and checkout currently happen serially. Overlapping them removes avoidable waiting from the highest-value onboarding path and removes the separate post-payment action that users can miss.

**Independent Test**: Complete a new primary-computer signup with a deliberately delayed checkout, verify that computer preparation begins after the checkout intent, and verify that the correctly sized computer with the selected region and agents becomes accessible only after billing authorization.

**Acceptance Scenarios**:

1. **Given** a signed-in new user with no primary computer or active billing access, **When** they choose compute power, region, and agents and explicitly continue to checkout, **Then** Matrix records one preparation intent for those selections and begins preparing one inaccessible primary computer while checkout is open.
2. **Given** preparation is in progress or complete, **When** a signed billing event authorizes the selected primary computer, **Then** Matrix activates that same computer for the user without creating a replacement.
3. **Given** preparation finishes before billing authorization, **When** the user remains in checkout, **Then** the computer stays inaccessible and the user sees that preparation is underway without seeing provider or infrastructure details.
4. **Given** billing authorization arrives before preparation finishes, **When** the user returns to Matrix, **Then** Matrix shows normal build progress and opens the computer when it becomes ready.

---

### User Story 2 - Recover Safely From Abandonment and Failure (Priority: P1)

A user may close checkout, let it expire, encounter a declined payment, or lose their browser. Matrix must reclaim an unauthorized prepared computer promptly without deleting a computer whose billing authorization arrived concurrently.

**Why this priority**: Prebilling preparation creates provider cost and an abuse surface before payment authorization. Bounded cleanup and race-safe ownership checks are required for the feature to be economically and operationally safe.

**Independent Test**: Start preparation, abandon checkout, advance beyond the preparation lease, and verify the resource is reclaimed; repeat with billing authorization racing cleanup and verify the authorized computer always survives.

**Acceptance Scenarios**:

1. **Given** an unauthorized prepared computer whose 30-minute preparation lease has expired, **When** the cleanup process evaluates it, **Then** Matrix rechecks current billing authorization and reclaims it only if authorization is still absent.
2. **Given** billing authorization and cleanup occur concurrently, **When** both operations settle, **Then** the authorized computer remains assigned and accessible and no replacement computer is created.
3. **Given** checkout creation fails before a checkout session is available, **When** the failure is returned to the user, **Then** Matrix does not begin provider preparation.
4. **Given** provider preparation fails while checkout remains available, **When** the user completes billing, **Then** Matrix preserves the authorized purchase and uses the normal retryable provisioning path without exposing raw provider errors.

---

### User Story 3 - Resume Without Duplicates (Priority: P2)

A user can refresh, retry, or reopen onboarding while checkout or preparation is active. Matrix resumes the same intent and selections rather than creating duplicate checkout sessions or computers.

**Why this priority**: Browser retries and ambiguous network outcomes are ordinary onboarding behavior. Idempotent resumption prevents duplicate infrastructure cost and confusing selection drift.

**Independent Test**: Repeat the continue-to-checkout action concurrently and after simulated client timeouts, then verify one open checkout intent and at most one active provider computer exist for the primary slot.

**Acceptance Scenarios**:

1. **Given** an active preparation intent, **When** identical continue requests are retried or arrive concurrently, **Then** Matrix returns the existing checkout destination and preparation state.
2. **Given** an active preparation intent with different compute, region, or agent selections, **When** the user attempts to start another checkout, **Then** Matrix explains that an existing checkout must be resumed or abandoned before the selections can change.
3. **Given** the browser times out after Matrix accepted the preparation request, **When** the journey is refreshed, **Then** authoritative server state shows checkout and preparation progress without requiring another computer creation request.

---

### User Story 4 - Preserve Existing Lifecycle Behavior (Priority: P3)

Existing customers, additional computers, recoveries, resizes, billing grace, suspension, and operator previews continue using their established authorization and lifecycle rules.

**Why this priority**: The optimization targets one onboarding path and must not weaken entitlement enforcement or destabilize established machine operations.

**Independent Test**: Run existing lifecycle suites and verify that only an eligible new primary-computer checkout can enter prebilling preparation.

**Acceptance Scenarios**:

1. **Given** an existing paid customer or an additional-computer flow, **When** they provision or manage a computer, **Then** the existing authorization and lifecycle remain unchanged.
2. **Given** an unauthorized client tries to access, route to, recover, resize, or resume a prepared computer, **When** Matrix evaluates the request, **Then** access is denied with a generic response.
3. **Given** an operator preview request, **When** it is processed, **Then** it remains governed by the separate preview authorization and capacity policy.

### Edge Cases

- The Stripe session is created but the response to Matrix is ambiguous or times out.
- The user completes checkout after the local preparation lease expires but before cleanup runs.
- Cleanup starts before the billing webhook transaction commits and completes afterward.
- A stale checkout-expired event arrives after a newer subscription event has authorized the computer.
- Provider creation times out after the provider may have accepted the request.
- The selected plan and region are individually valid but unavailable in combination.
- The user selects no coding agents.
- The user signs out or switches accounts while checkout is open.
- The same account opens onboarding in multiple browser tabs.
- The global provisional-computer capacity limit is reached.
- Preparation completes but runtime health never becomes ready.
- Billing authorization is later revoked under the existing trial, grace, or cancellation policy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST collect and validate compute power, region, and default-agent selections before offering the action that begins checkout and preparation.
- **FR-002**: The action that begins preparation MUST clearly tell the user that Matrix will start preparing their selected computer while secure checkout is open.
- **FR-003**: Matrix MUST create a durable, owner-scoped preparation intent before requesting provider preparation.
- **FR-004**: A preparation intent MUST bind the authenticated user, primary runtime slot, selected plan, billing interval, compute shape, region, agent selections, checkout attempt, lifecycle state, and preparation lease.
- **FR-005**: Matrix MUST begin provider preparation only after a valid checkout session for the same intent is available.
- **FR-006**: Matrix MUST allow at most one active checkout/preparation intent and at most one active customer computer per authenticated user and runtime slot.
- **FR-007**: Identical retries and ambiguous client outcomes MUST converge on the existing preparation intent, checkout session, and computer.
- **FR-008**: Matrix MUST reject selection changes while an existing checkout remains payable unless that checkout and its preparation intent have first become authoritatively abandoned or expired.
- **FR-009**: A prepared computer MUST remain inaccessible through runtime routing, application sessions, recovery, resize, resume, terminal access, and owner traffic until authoritative billing authorization exists for that exact runtime slot.
- **FR-010**: Browser redirects, client storage, checkout completion pages, invoice events, and local preparation state MUST NOT independently authorize runtime access.
- **FR-011**: Initial runtime access MUST continue to come only from the established signed subscription projection for a recognized plan and exact runtime slot.
- **FR-012**: Billing authorization MUST promote the existing prepared computer rather than create a replacement when its bound intent and selections remain valid.
- **FR-013**: Preparation and authorization MUST use explicit lifecycle states that prevent unauthorized routing and distinguish preparation from normal entitled provisioning.
- **FR-014**: An unauthorized preparation intent MUST use a 30-minute expiration policy with no more than one minute of API transport and clock-skew safety headroom, unless it has been authoritatively renewed by resuming the same payable checkout under a bounded policy.
- **FR-015**: Matrix MUST periodically reclaim expired unauthorized prepared computers and all associated platform-owned secrets, credentials, and transient records.
- **FR-016**: Cleanup MUST re-resolve current billing authorization and the current intent revision immediately before every irreversible provider deletion; authorization or a newer intent MUST fence out stale cleanup.
- **FR-017**: Provider creation and deletion outcomes that are ambiguous MUST be reconciled against provider state before retrying so Matrix does not leak or duplicate computers.
- **FR-018**: Preparation MUST have bounded per-user, per-runtime-slot, per-network-origin, and global concurrency controls. Global unpaid admission MUST use one count-only ceiling across all offered machine sizes.
- **FR-019**: Capacity exhaustion MUST fail closed without creating a provider resource, MUST preserve checkout safety by continuing with post-authorization fallback provisioning, and MUST expose only a generic preparation status if the user needs to be informed.
- **FR-020**: Plan, compute shape, region, agent selections, runtime slot, and return path MUST be validated at their request boundaries before any external call or persisted intent.
- **FR-021**: External billing and provider calls MUST have bounded timeouts, idempotency keys where supported, and generic client errors with detailed server-side diagnostics.
- **FR-022**: Related writes for intent, checkout linkage, machine ownership, lifecycle transitions, cleanup claims, and authorization promotion MUST be atomic, and concurrency conditions MUST be enforced in the writes themselves.
- **FR-023**: Preparation failures MUST NOT revoke or invalidate a successful billing authorization; an entitled user MUST fall back to the existing retryable provisioning journey.
- **FR-024**: The journey UI MUST show distinct, resumable states for choosing agents, opening checkout, preparing during checkout, waiting for billing confirmation, authorized provisioning, failure, and readiness.
- **FR-025**: User-facing preparation and health states MUST expose only coarse progress and safe actions, never provider names, raw upstream statuses, internal identifiers, network details, database errors, or filesystem paths.
- **FR-026**: Preparation state changes, checkout state changes, authorization, cleanup, and failures MUST emit bounded telemetry sufficient to measure conversion, latency overlap, duplicate prevention, active unpaid exposure, and cleanup lag.
- **FR-027**: V1 MUST apply only to new-user primary-computer onboarding; existing paid provisioning, additional computers, recovery, resize, suspension, billing grace, and operator-preview behavior MUST remain unchanged.
- **FR-028**: A prepared computer MUST be permanently bound to its initiating owner and MUST never be reassigned to another user, whether preparation succeeds, fails, or is abandoned.
- **FR-029**: Abandoned owner data and credentials created during preparation MUST be deleted according to the same owner-deletion guarantees as other Matrix data, while billing and security audit records retain only the minimum required history.
- **FR-030**: The public onboarding documentation MUST explain the new compute → agents → checkout/preparation → billing authorization → ready sequence without exposing private operator details.

### Key Entities

- **Preparation Intent**: The durable owner-scoped record connecting one validated onboarding selection, one checkout attempt, one provisional machine lifecycle, a bounded lease, and its current concurrency revision.
- **Checkout Attempt**: The payable billing session associated with the preparation intent; it remains billing state and cannot itself grant runtime access.
- **Prepared Computer**: A customer-specific primary computer that may be building or ready but remains inaccessible until authoritative billing authorization.
- **Billing Authorization**: The existing signed, slot-specific subscription projection that alone permits initial hosted runtime access.
- **Cleanup Claim**: A bounded, fenced decision to reconcile and reclaim an expired unauthorized prepared computer.
- **Onboarding Selection**: The user-approved compute, region, billing interval, and default-agent choices bound immutably to an active checkout/preparation intent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Median time from billing authorization to a ready primary computer decreases by at least 60% compared with the checkout-before-provisioning baseline.
- **SC-002**: At least 80% of eligible users who spend 60 seconds or more in checkout receive a ready computer within 20 seconds after billing authorization.
- **SC-003**: In 100% of authorization tests, a prepared computer remains inaccessible before a valid slot-specific billing authorization and becomes accessible only after that authorization.
- **SC-004**: Concurrent retries, browser refreshes, ambiguous responses, and multi-tab tests create zero duplicate checkout/preparation intents and zero duplicate provider computers.
- **SC-005**: At least 99% of abandoned unauthorized computers are reclaimed within 35 minutes of preparation intent creation; 100% are reclaimed within 45 minutes outside a declared provider outage.
- **SC-006**: Billing-versus-cleanup race tests produce zero deletions of an authorized computer and zero cases where a stale expiry event reverses a newer authorization.
- **SC-007**: The share of billing-authorized new users with no machine and no active provisioning job falls to zero in end-to-end test coverage and remains below 0.1% in production monitoring.
- **SC-008**: Existing billing, provisioning, recovery, resize, suspension, preview, and additional-computer contract suites pass without behavior changes outside the explicitly eligible onboarding cohort.
- **SC-009**: User-facing errors reveal no provider names, raw infrastructure errors, internal identifiers, network details, database details, or filesystem paths in all tested failure paths.
- **SC-010**: Under concurrent mixed-size checkout admission, the platform prepares at most the configured number of unpaid computers and defers the next intent without weakening duplicate-prevention or billing-authorization guarantees.

## Assumptions

- V1 optimizes only a new user's primary hosted computer; expansion to additional computers is deferred until production cost and conversion data justify it.
- Preparation begins after the user has selected compute, region, and agents and explicitly continues to checkout, not immediately when a compute card is highlighted.
- A checkout session must exist before provider preparation begins, but payment or trial authorization does not need to be complete.
- The signed subscription projection remains the sole authority for initial runtime access.
- Prepared computers are owner-specific from creation and are destroyed rather than pooled or reassigned when abandoned.
- A 30-minute preparation lease balances ordinary checkout completion time against abandoned-provider cost; a bounded sweeper provides the cleanup grace measured in the success criteria.
- Agent authentication still happens after the computer is ready; this feature only captures which supported agents should be installed.
- Existing golden-snapshot provisioning remains the latency foundation; this feature changes when customer-specific preparation begins, not how the base image is built.
- Provider preparation failure does not block a user from completing checkout because existing entitled provisioning retry behavior remains the recovery path.

## Out of Scope

- Warm pools or reusable unassigned computers.
- Runtime access before billing authorization.
- Changes to Stripe plan pricing, trial duration, grace periods, cancellation, suspension, or payment-recovery policy.
- Automatic changes to a user's selected region or compute shape when provider capacity is unavailable.
- Prebilling recovery, resize, additional-computer provisioning, operator previews, or self-hosted runtimes.
- Reusing an abandoned prepared computer for another owner.
- Installing or authenticating coding agents before the user owns an authorized runtime.
