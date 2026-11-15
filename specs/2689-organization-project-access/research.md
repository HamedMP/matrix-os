# Research: Organization-wide Project Access

## Decision 1: Organization membership is the only project work grant

**Decision**: For a live shared project, `collaboration_scopes.organization_id` plus fresh active membership for both the project owner and requesting actor is sufficient for the full contributor work action set. The owner keeps private owner access independently. No project grant, activation, role, or invitation is consulted.

**Rationale**: The project is already explicitly attached to one organization, and every request already has a bounded organization precondition. Reusing those facts makes future members automatic, removes competing policy state, and preserves a fail-closed boundary.

**Alternatives rejected**:

- Auto-create contributor grants for every member: still leaves duplicated state, onboarding races, and cleanup jobs.
- Keep one organization grant but remove activation: simpler than today, but the grant duplicates the scope's organization/lifecycle and can drift.
- A public-link model: exceeds the approved organization-only boundary.

## Decision 2: Full access is a bounded work capability set, not administration

**Decision**: Members receive the current contributor actions for project content and tools. Share/unshare, whole-project deletion, and Provider Settings/billing remain explicit project-owner checks outside that set. Organization membership administration remains a separate organization-policy check and is never inferred from project ownership.

**Rationale**: This delivers the user's "everyone can work" intent without transferring ownership, financial authority, credentials, or organization control.

**Alternative rejected**: Giving members literal owner equivalence would contradict data ownership and expose destructive/financial controls.

## Decision 3: The current Provider Settings V3 active route governs AI

**Decision**: Each shared AI request uses the owner's current global `AiProviderSnapshotV3.active` tuple. The exact provider instance, access source, and model must be ready and verified at admission/dispatch. No per-project source, model allowlist, acknowledgment, or submit-mode policy exists.

**Rationale**: Provider Settings already projects one current active route from the owner's saved selection and readiness. Using it eliminates the second configuration system that currently lives in `collaboration_execution_policies`.

**Alternatives rejected**:

- Copy Provider Settings into the project at share time: becomes stale and requires reconfirmation.
- Let members pick among owner connections: exposes configuration and spend choices that remain owner-controlled.
- Fall back to another ready route: can silently change payer, provider, model, or data policy.

## Decision 4: Bind runs, not projects

**Decision**: Keep an immutable per-run record of the exact AI route and owner/settings generation used. Remove policy revision and allowed-model semantics from project authorization.

**Rationale**: A running or auditable request needs provenance, but a project does not need a durable AI choice. Binding at run granularity supports session safety while allowing later requests to follow later global Settings.

**Alternative rejected**: No binding at all would make queued/resumed work susceptible to unnoticed account changes.

## Decision 5: Existing project policy rows become inert

**Decision**: Do not add a database migration or delete historical grant/activation/execution-policy rows during the initial cutover. Project serving paths ignore them. Standalone resource sharing may continue using grants until separately simplified.

**Rationale**: The scope already contains all new canonical fields. Avoiding destructive migration makes rollback safer and prevents a large table rewrite from obscuring the authorization change.

**Alternatives rejected**:

- Delete legacy rows immediately: destroys rollback/audit context.
- Add an access-mode column: unnecessary because the new rule applies uniformly to project scopes in V1.
- Continue writing synthetic project rows: perpetuates dead state and ambiguity.

## Decision 6: Membership is verified on every protected operation

**Decision**: Preserve the existing bounded organization precondition and request-time enforcement. Cache entries may improve latency only within their evidence deadline; they are never durable authorization.

**Rationale**: Removing product restrictions must not weaken the security boundary. A member removal must stop new work and trigger the existing session/run revocation machinery.

**Alternative rejected**: Trusting project-open state or a long-lived activation would delay revocation.

## Decision 7: Existing projects cut over automatically

**Decision**: Any existing shared project with a valid organization becomes organization-full-access on deployment, regardless of historical Viewer/Editor grants or activation state. Private/unshared projects remain private.

**Rationale**: A mixed model would be hard to explain and would preserve the operational complexity the change is intended to remove.

**Alternative rejected**: Require owner reconfirmation per existing project; this delays the product correction and creates two V1 behaviors.

## Decision 8: Archived projects stay read-only

**Decision**: Preserve the current archived lifecycle narrowing to read-only. The organization-full-access rule applies to live shared projects; lifecycle constraints remain authoritative.

**Rationale**: Archive is a project lifecycle state, not a collaboration role, and should continue preventing mutation.

## Decision 9: UI exposes one decision

**Decision**: The project Share dialog states the selected organization, what shares, and that all active members can work. It offers share/unshare only; it does not render people, roles, general access, AI source, model, or acknowledgment controls.

**Rationale**: UI should mirror the single serving rule and avoid implying controls that the backend does not enforce.

## Resolved Unknowns

- **Schema migration**: none for initial cutover.
- **Existing project behavior**: automatic cutover.
- **Future members**: automatic access after authoritative membership becomes active.
- **Member acceptance**: none.
- **AI selection**: owner's global active Provider Settings route at request time.
- **Fallback**: none.
- **Standalone shares**: unchanged compatibility path.
- **Credentials**: never exposed to collaborators.
