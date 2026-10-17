# Company OS delivery and validation plan

**Status:** Proposed sequence, not an implementation commitment
**Issue:** [ENG-2](https://linear.app/matrix-os/issue/ENG-2/specify-company-os-master-agent-and-contextual-workspace)
**Product contract:** [spec.md](./spec.md)

## Current change

This PR adds two English Markdown documents. It changes no product code, database,
authorization, default provider, deployment, source connection or user data.
The issue remains in Scoping until the specification is reviewed; opening or merging
the spec PR must not close a future implementation outcome as shipped.

Private evidence remains in Linear. Publish only synthetic fixtures and redacted
receipts with explicit scope. Do not commit private recordings, signed video links,
real directory/candidate records, mailbox excerpts, or inferred personal details.

## Decision register

| ID | Decision | Proposed starting point | Gate |
| --- | --- | --- | --- |
| D1 | App versus OS-view composition | Vite + React workspace using typed Matrix bridge; thin shared widget/input adapter | Before S1 implementation; prove bridge and window lifecycle fit |
| D2 | First real sources and accounts | A selected calendar, project tracker and document source for the first decision; verify each adapter | Before S2; product owner selects accounts and scope, without an all-tools promise |
| D3 | Master/specialist harness capability | Reuse admitted canonical Agent/Recipe runs; provider-neutral contracts | Spike real subagent events, read-only enforcement and recovery before choosing an adapter |
| D4 | Personal versus shared context and approval authority | Owner-only read pilot; resource-level audiences, explicit action approver | Before shared reads/actions; reconcile organization V1 policy gap |
| D5 | Durable memory and source lifecycle | Reuse accepted ENG-1 contract; retain provenance and user corrections | Before ingestion; decide retention, correction, forget and no-resurrection rules |
| D6 | Background work and proactivity | User-triggered first; opt-in bounded refresh with visible status later | Before scheduling; agree freshness, notification policy, costs and quotas |
| D7 | External action shortlist | One selected, reviewable action type at a time | Before S3; specify exact payload, authority, idempotency and reconciliation |
| D8 | Native Mobile scope | Responsive Web Mobile in S1; dedicated native adaptation packet or explicit temporary limitation | Before connected launch; no advertised native capability without parity |
| D9 | Brand and workflow configuration | Existing Matrix brand/window primitives; generic role/stage examples | Before visual implementation; validate product branding and onboarding copy |
| D10 | Priority selection and success measures | Three-or-fewer evidence-backed items, no fabricated urgency | Before S2; agree ordering, dismissal/refresh semantics and usefulness criteria |

These decisions do not block documenting the requested product. They block claims
that the feature is fully specified for backend execution or ready for production.

## Work packets

### S0 - Requirements and review (this PR)

- [x] Read the request, image, recording/voice and full reusable brief.
- [x] Write a public-safe product contract with traceable requirements.
- [x] Inspect current recipe, integration, readiness, ATS and collaboration seams.
- [x] Separate requirements, proposed architecture and unresolved decisions.
- [x] Record the read-only/approval gap and explicit surface scope.
- [ ] Obtain product review of the specification and stage boundaries.

No runtime spike is reported as complete. The existing recipe resolver and readiness
service are code observations; connector freshness and provider behavior need live tests.

### S1 - Complete interaction validation

Resolve D1/D9 and create an isolated, independently runnable review build. Keep mock
adapters separate from production connector clients, with clearly labeled fictional
data and deterministic simulated failure controls. Follow Red -> Green -> Refactor
for interaction/state behavior; do not write tests that merely restate static copy.

Build the default assistant dock, compact input, result panel, all six sections, profile and
candidate drawers, both hiring pipelines, GTM relationship-dependent drafts,
collaboration filters/handoffs and four workflow examples. Each control must reach
a meaningful state or clear simulation feedback. No external operation may be reachable.

Use the [September 23 dock reference](./dock-design.md) for the collapsed vertical
rail and inward-expanding panel. Validate rail selection, panel switching, preserved
drafts, dismissal/focus return, expansion to the workspace, shell-chrome collision,
reduced transparency/motion and narrow-screen adaptation. Reference screenshots are
source evidence; they do not count as screenshots of the implemented Matrix product.

Use shared product derivation for Web Canvas, Web Desktop and Electron Desktop;
validate responsive Web Mobile. Register the product identity through the existing
app/window system rather than adding renderer-specific parallel routing. Preserve
existing open work and the user's wallpaper. Avoid changes to unrelated Chat UI.

Checkpoint: targeted interaction/accessibility/state tests and exact-build screenshots
or recordings on every applicable surface, then explicit Human Review. Example
output does not count as real grounding or backend acceptance.

### S2 - Grounded owner-only read pilot

Resolve D2/D3/D5/D10 and freeze the typed data contracts, exact route/auth matrix,
source adapter capabilities and resource constants before implementation. Each new
route must list its method, path, body limit, principal, resource authority, response
schema and error mapping. No public content routes or generic action passthrough.

Run bounded throwaway spikes for undocumented behavior: admitted recipes and source
selection, child-agent capability inheritance, alternative write paths, cancellation,
resume, event provenance and source revocation. A read-only prompt is not sufficient;
an adapter that can write through another tool is ineligible until restricted.

Implement owner-scoped durable references and artifact receipts with Kysely/Postgres.
Use canonical run/session identity and source authority rather than a second transcript
database. Preserve corrections, distinguish imported data from live reads, and show
coverage and source timestamps. Keep candidate/business data local to its owner.

Proposed startup and wiring contract:

1. Existing gateway bootstrap establishes authenticated principals, selected runtime
   identity, owned database pools and integration dependencies.
2. Create/inject Company OS repositories and a scope/evidence resolver; verify their
   readiness before registering routes or tools. Missing dependencies return generic
   unavailable states rather than not-found or synthetic fixture fallbacks.
3. Bind the master workflow to the existing recipe resolver and canonical dispatcher.
   Freeze actor, owner, workspace, selected connections, provider and capability set
   on admission; revalidate live authorization before protected operations.
4. Feed authorized evidence and actual specialist events into shared result contracts.
   Persist artifact revisions and event/outbox writes atomically, then publish via the
   existing authorized realtime path.
5. Render the same contract in the widget and expanded app via typed transport/bridge.
   No `globalThis`, renderer tokens, raw provider payloads or direct iframe fetches.
6. Optional workers start only after policy/configuration is present. Shutdown first
   stops admission, aborts work and drains listeners, then closes owned dependencies.

The implementation plan must replace these responsibilities with verified constructors,
registration locations and configuration flow before coding. Do not add more behavior
to a 1,000+ line entry point without extracting a focused composition module.

Checkpoint: an authenticated source read -> canonical master/specialist run -> persisted
evidence/artifact -> no-reload UI result, followed by restart and revoked-source tests.
No sending, CRM updates, real recipient assignments or recurring jobs in this stage.

### S3 - Approved actions, shared work and optional refresh

Resolve D4/D6/D7/D8. Keep organization membership and resource authorization in the
existing authority layer. Add only the missing generic capability/approval contract,
not a Company OS bypass or a second membership table. Shared source access requires
source/audience checks, not just permission to read a workstream title.

For each enabled action:

1. Prepare a draft with selected account, target/recipient, payload, sources and revision.
2. Show the exact effect and designated approver; allow edit, reject or cancel.
3. Approval binds the immutable revision and expires. Edits require fresh approval.
4. Execution rechecks current policy, connection authority, source access and approval.
5. Persist a durable receipt. If the outcome is uncertain, reconcile with the provider
   before retry; never claim success from dispatch alone.

Test candidate stage changes and CRM reconciliation as mutations, not as harmless
reads. Do not automate employment decisions. Provider-draft creation is also an
external write and must have an explicit user action/contract.

Optional 24/7 source refresh uses durable leases, bounded queues and checkpoints. It
is user-controlled, can pause, avoids overlapping syncs, exposes last/next success,
and does not repeatedly call an LLM without new relevant input. Notifications require
an agreed useful-change policy; this spec does not create an automation.

Checkpoint: one approved operation with independently verified provider state,
duplicate-click/race/crash tests, stale-approval denial, source revocation and shared
audience isolation. Validate a selected test account before any broader rollout.

### S4 - Product validation, release and documentation

- Confirm a first-time user understands the product, finds a priority and owner,
  navigates all sections, recognizes provenance and knows which actions need review.
- Verify current exact-head behavior on Web Canvas, Web Desktop and Electron Desktop;
  include Web Mobile and Native Mobile according to the approved scope. A browser
  screenshot never substitutes for Electron or a physical Native Mobile run.
- Record independent outcomes for UI acceptance, grounding, approval/execution,
  authorization, reconnect/restart and data lifecycle.
- Use disposable, explicitly scoped VPS/test accounts for risky runtime validation;
  publishing a host bundle and deploying it are separate authorized steps. Production
  customer runtime is VPS-native, not a Docker Compose rollout.
- Obtain exact-build Human Review, required CI and current-head Greptile 5/5 before
  an authorized merge. Documentation review does not approve the future product UI.
- Deliver a separate English PR in `FinnaAI/matrix-os-site` under `content/docs/`
  alongside the accepted implementation. Document setup/source selection, supported
  workflows, provenance, approval, sharing, privacy/export/delete and recovery. Do not
  publish unshipped capabilities or recreate the website in this repository.

## Acceptance and regression matrix

| Scenario | Requirement | Minimum evidence |
| --- | --- | --- |
| New user opens Company OS after setup; optional sources skipped | R1/R2 | Prebuilt identity, honest readiness, no fabricated priorities or unapproved source reads |
| Source yields zero, one or three priorities | R2/R4 | Matching count/copy, visible owner, source and next action |
| Open/close/minimize/expand, reload and switch presentation | R2/R4/R10 | Same selected workspace/item/draft/run; correct focus return and retained geometry |
| Select/switch assistant-dock icons; dismiss; expand; resize viewport | R2/dock design | One anchored panel, persistent rail, truthful selection, retained drafts, keyboard focus return; no overlap with protected shell chrome |
| Voice start/stop/cancel and permission denial | R2/R10 | No pre-activation recording; compact control, text fallback and documented cleanup |
| Navigate all six sections with keyboard and pointer | R4-R10 | No dead entry, accessible active state and useful first viewport |
| Open directory role with restricted source context | R5 | Authorized details only; directory presence grants no source access |
| Switch pipelines and inspect candidate | R6 | Correct stages/details, source context, draft-only assistance; no hidden stage write |
| Switch GTM relationships while an edited draft and async read exist | R7 | Correct relationship draft, preserved edits, stale-result fencing |
| CRM/campaign reconciliation retries or races | R7/S3 | Stable mapping, no duplicate record, actual reviewed side effect and receipt |
| Open decision, share brief, assign handoff, apply My work | R8 | Correct actors/audience/state, recipient checks, failure preserves local work |
| Run each of the four example workflows | R9/R3 | Answer/artifact, actual or explicitly simulated specialists, evidence and review action |
| Source is stale, revoked, disconnected, slow or contradictory | R1/R3 | Coverage/freshness visible, protected data hidden, no invented successful result |
| Model receives malicious instructions embedded in source content | R3/security | No scope escalation, credential disclosure, approval or outbound write |
| S2 agent attempts writes through MCP, subprocess or network alternatives | security | All paths denied before external effect; real tool trace, not prompt-only assertion |
| Two approvers submit the same action or edit after approval | S3 | One accepted immutable effect; stale revision denied and audit consistent |
| Provider succeeds then connection/process fails | S3 | Outcome unknown/reconciled state, no blind resend and truthful receipt |
| Team membership/source grant is removed during a run | R8/security | Pending access/actions revoked; no leak in result, stream or notification |
| Correct/forget/export context, then re-import/restart | lifecycle | Correction retained, deletion does not resurrect, export excludes unauthorized data |
| Offline, failed save or reconnect after navigation | R10 | Draft retained, safe errors and recovery, no false success or wrong-scope update |
| 1280x800 and 1440x900 windows; 390px responsive viewport | R10 | Readable content, no accidental horizontal overflow, keyboard and reduced-motion checks |

Use real Postgres transactions for concurrency/authorization tests, deterministic
synthetic source fixtures for repeatable CI, and separately scoped live connector tests
for actual source effects. Record test-account scope without exposing its contents.

## Local and review validation

For this documentation-only PR: check whitespace, relative links/source references,
English-only prose, requirement coverage, privacy and consistency with existing specs.
Run repository-required typecheck, pattern scan and unit checks where the environment
supports them; record baseline failures explicitly. No tests are added merely to assert
the wording of these documents, and no UI screenshot is claimed for unchanged code.

For future code packets: TDD for behavioral changes; focused contract/repository/route/
renderer tests; required `bun run typecheck`, pattern checks and affected test suites.
Run React audit for React changes, production shell build for Web-facing changes,
Electron build for trusted-host/packaging changes, and mobile gates for native changes.
Keep validation within the packet's scope; expand only when failures or new edits justify it.

Implementation PRs must include the five-surface evidence matrix and the invariants:
canonical state, transaction/lock scope, acceptable partial failures, authorization
source and deferred scope. Split work by independently reviewable behavior; use Graphite
if the implementation requires dependent stacked PRs. This spec PR is a single branch.
