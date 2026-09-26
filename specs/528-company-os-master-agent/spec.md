# Company OS: master agent and contextual workspace

**Status:** Proposed product contract; scope review required before implementation
**Tracking:** [ENG-2](https://linear.app/matrix-os/issue/ENG-2/specify-company-os-master-agent-and-contextual-workspace)
**Date:** 2026-09-22
**Delivery and validation:** [plan.md](./plan.md)

## Outcome

Company OS is a prebuilt master agent with a compact OS-view entry point and an
expanded operating workspace. After onboarding and authorized source selection,
it helps a user understand what needs attention, why it matters, who owns the next
step, and which action is ready for review. It combines work context across tools
without making users repeatedly explain their individual or team's work.

The primary audience is founders, chiefs of staff, COOs, operations managers,
commercial leaders, and non-technical teams coordinating with technical peers.
The experience should feel calm, decisive, and native to Matrix OS.

This PR specifies the product. It does not implement a widget, connect accounts,
run agents, deploy a prototype, or authorize outbound actions.

## Evidence and interpretation

The private source record in ENG-2 contains a product request, a context-fragmentation
image, an approximately 2:01 narrated recording, and a 264-line reusable prototype
brief. This specification contains only generalized requirements and fictional
examples; private media, access tokens, people, candidate records, and business
activity stay outside this repository.

| Evidence | Product requirement | Limit of the evidence |
| --- | --- | --- |
| Request and recording 00:00-00:29 | A master agent comes standard; onboarding establishes individual and team context | No precise ingestion schedule, memory algorithm, or connector launch list was agreed |
| Image: a launch email surrounded by disconnected work tools | Combine relevant context into useful decisions and drafts | Every depicted application is not automatically a required integration |
| Recording 00:29-00:40 | Compact voice interaction over the working environment | Not evidence for an always-on microphone or background recording |
| Recording 00:41-01:26 and reusable brief | Today, directory, hiring, GTM overview, collaboration, workflows | Supplied real data is not proof of continuously synchronized connectors |
| Recording 01:29-01:40 | Direct answer, specialist contributions, source evidence, proposed action | A displayed duration is not a latency SLA; static completion marks are not run receipts |
| Recording 01:41-02:01 | Continue with a follow-up request from the result | The requested external change is not shown completing |
| Reusable brief | Standalone, interactive, responsive prototype with fictional or explicitly supplied data | Prototype actions must not change external systems |

Confirmed requirements use **must** below. Delivery stages, safety contracts, and
platform composition are proposed engineering decisions, not claims that the
recording demonstrates their implementation. Open product choices remain explicit.

## Scope and delivery stages

The eventual product can act after human approval. The reusable prototype brief
requires no external writes. These are separate stages, not conflicting promises.

| Stage | Deliverable | Action boundary |
| --- | --- | --- |
| S0: this PR | Product specification, platform boundaries, validation and delivery plan | Documentation only |
| S1: interaction validation | Complete connected-feeling experience using clearly marked fictional fixtures; independently runnable review build | No real connectors, messages, CRM writes, invitations, or background tasks; action feedback explicitly says it is simulated |
| S2: grounded pilot | Selected real read sources, owner-scoped context, real run/evidence receipts, reviewed artifacts | Read-only execution enforced by capabilities; preparation does not send or update anything |
| S3: approved actions and shared operation | Individually admitted mutations, durable receipts, authorized team work and optional background refresh | Blocked until source-specific action controls and organization policy compatibility are proven |

S1 is a controlled validation checkpoint, not a production-quality exception or
a claim of feature completion. Its UI and contracts should be reusable. S2 and S3
need separately reviewed implementation packets and explicit source selection.

Non-goals for this specification PR: a provider migration, a new foundation model,
a replacement CRM or campaign platform, a new general-purpose team chat, autonomous
hiring decisions, unreviewed outbound activity, all candidate integrations at once,
and a second memory or organization authorization system.

## Platform capabilities and Company OS composition

Company OS is a first-party experience built on reusable Matrix capabilities.
Generic context retrieval, connector authorization, agent execution, evidence,
approval, and ownership belong in platform contracts available to other apps.
Company-specific priority rules, pipeline views, workstream layout, and templates
belong to the Company OS application. Do not hardcode its business workflows in
the kernel or duplicate integration clients in its UI.

The implementation must evaluate a Vite + React first-party app for the expanded
workspace and a thin shared OS-view widget adapter. If the app bridge cannot carry
the required authenticated contracts, extend the typed bridge rather than allowing
direct iframe network access or broadening its CSP. The final composition is D1 in
the decision register; no new built-in route identifier is reserved by this PR.

Relevant baseline at `7f47c9b8d`:

| Existing seam | Reuse or limitation |
| --- | --- |
| [Agent recipe resolver](../../packages/gateway/src/chat/agent-recipe.ts) and [recipe editor](../../packages/ui/src/chat-agents/AgentRecipeEditor.tsx) | Reuse saved Agent identity, skill dependencies, selected integrations, immutable run context, and shared presentation; validate actual harness support |
| [Agent Recipes plan](../121-chat-agent-templates/recipe-plan.md) | Existing full-access recipe instructions are not an enforced read-only sandbox; Company OS cannot infer action safety from a prompt |
| [Company brain readiness](../../packages/gateway/src/onboarding/company-brain-readiness.ts) | Currently an owner-keyed in-memory readiness service; not durable company memory, a synchronization engine, or teammate authorization |
| [Integration routes](../../packages/gateway/src/integrations/routes.ts) | Reuse authenticated account selection and service execution; inspect each connector's read/write capabilities before admitting it |
| [Personal Brain](../114-personal-brain-mail/plan.md) | Align source identity, resumable ingestion, freshness, and corrections; do not create a competing mailbox store |
| [Organization collaboration](../124-organization-collaboration/spec.md) | Reuse membership/resource authority. Its V1 owner-connection execution does not supply Company OS's per-action approval boundary |
| [Recruiting ATS](../108-recruiting-ats/spec.md) | Careers intake/admin ATS is a separate domain; Company OS initially summarizes selected CRM hiring records, not the private recruiting database |
| [OS-view parity](../119-os-view-parity/spec.md) | Shared semantics and owner state across renderers; Electron Desktop is the ongoing shared visual reference |

[ENG-1](https://linear.app/matrix-os/issue/ENG-1/specify-pi-assistant-harness-evaluation-and-shared-agent-memory)
owns the independent Pi/shared-memory evaluation. Company OS can consume an accepted
memory contract but does not mandate Pi, copy provider memory folders, or wait for a
provider replacement to validate its interface. A spec reference is not evidence
that the referenced implementation is shipped or accepted.

## Product requirements

### R1. Onboarding and default availability

- The master agent must be prebuilt and discoverable without requiring users to
  assemble specialist bots or author a prompt first. Default availability does not
  grant data access, enable recording, or run background jobs.
- Onboarding must establish workspace/company name, relevant team roles, preferred
  product style, selected tools/accounts, two or three priorities, applicable hiring
  or commercial stages, and whether supplied data is real, anonymized, or fictional.
- Users may skip optional setup. Missing sources must yield useful setup guidance,
  not invented priorities or an assertion that all company context is known.
- Show acquisition progress and coverage: not connected, importing, ready, partial,
  stale, or action needed. Identity, counts, and status must reflect the selected scope.
- A workspace is an experience boundary, not an authorization grant. Personal data
  must never become team context merely because a company name was entered.

### R2. Compact assistant dock and input

- Use a narrow, vertically stacked assistant dock near the upper-right edge of Web
  Desktop and Electron Desktop. The September 23 design reference refines “widget”
  into a persistent icon rail with one contextual panel expanding inward to its left.
  See [visual evidence and interaction contract](./dock-design.md), including three
  screenshots from the public reference reel. This is separate from the OS app dock.
- Keep the collapsed rail compact; place identity, connection indicator,
  minimize/expand, a neutral greeting, and the following content in its opened panel:
  up to three prioritized items with source labels and Decide / Review / Prep actions.
- Use “Three things need you.” only when there are three items. Fewer or zero items
  need truthful copy; never manufacture work to fill the design.
- The reference fixture contains launch-scope confirmation, a candidate review, and
  preparation for a customer meeting. Real items need rationale, responsible person,
  freshness and access-checked supporting context.
- Provide “Talk to your company”, keyboard/text input, and workflow examples.
- Voice opens a compact listening/transcript control with explicit start, stop and
  cancel, visible microphone state, and text fallback. It must not open a dominant
  chat page or record before user activation. Denied microphone permission preserves
  the rest of the experience. Spoken input is subject to the same action review.
- The small connections popover shows only relevant tools, selected account/scope,
  concise readiness/freshness and a repair/setup action. It is not a logo dashboard.
- Minimize, expand, light dismiss and Escape preserve the selected work and draft;
  closing Company OS must not stop unrelated agents or alter source data.
- Keep one compact panel open at a time. Switching rail destinations changes panel
  content in place; selecting the active destination or dismissing closes the panel
  while the rail remains available. Expand is a separate action into the existing
  six-section workspace. The reference supplies the dock/panel form, not an approved
  connector list, voice implementation, native overlay capability, or exact sizing.

### R3. Master agent and evidence-backed results

- One master agent coordinates relevant specialists using the same authorized context.
  Suggested roles include Chief of Staff, COO, CFO, Product Manager, Project Manager,
  GTM, Expansion, Social Media, Talent Partner, Communications and Executive Assistant.
  These are role examples, not a requirement to run eleven agents for each question.
- Results lead with a direct answer or prepared artifact, followed by specialist
  contributions, source evidence, proposed next action and the human-review boundary.
- Explain useful findings and evidence, not hidden model chain-of-thought. A specialist
  is marked complete only from a real run result; fixtures say “Example data”. If an
  adapter cannot expose specialist activity, show that limitation without invented events.
- Support an answer-side follow-up input that retains the selected scope and artifact.
  Editing an action creates a new revision and invalidates any approval for the old one.
- Candidate sources include Slack, Discord, Notion, Granola, Linear, Folk CRM, Lemlist,
  Clay, Google Drive, Gmail, Google Calendar and LinkedIn. Availability requires a
  verified adapter and user selection; this list is not a first-release commitment.
- Every evidence item identifies source, record reference, acquisition time, source
  version when available, and provenance. Use “Connected data”, “Example context”, or
  an explicit user-supplied/imported label; upload does not imply a live connection.
- Stale, conflicting, missing, inaccessible and partial evidence remains visible as
  a limitation. Source inspection must recheck current access before returning excerpts.

### R4. Expanded workspace and Today

- Expand into a native-feeling application window with narrow navigation and six
  working sections: Today, Company Directory, Hiring, GTM overview, Collaboration,
  and Workflows. Active navigation must be obvious and all entries must work.
- Today emphasizes priority decisions and ownership. Secondary pulse metrics use
  actual coverage or clearly marked fixture values: 3 active projects, 12 open hiring
  records, 4 meetings captured. They are not quotas or promised production counts.
- Opening and returning from an item must preserve selection, unsent edits and context.

### R5. Company Directory

- Show role, current focus and available authorized working context. The fixture uses
  Chief Executive, Technology Lead, Operations Lead, Product Engineer and Growth Lead.
- Clicking a profile opens a dismissible drawer with role, optional broad region,
  current focus and connected context. Use fictional initials or role icons in examples.
- Directory membership is not permission to inspect another person's private accounts.

### R6. Hiring

- Provide a CRM-powered ATS view with Engineering and GTM pipeline switching.
- Engineering stages: To Review, Initial Screening, Technical Interview, Trial.
- GTM stages: To Review, Screening, Case, Trial.
- Candidate cards occupy stage columns and open a drawer with pipeline, stage, role,
  company, tags, interaction signals and available evidence sources.
- Include “Ask Talent Partner” and “Draft follow-up”. Prepared recommendations and
  communications stay reviewable; no automatic candidate ranking, rejection, advancement,
  or inferred sensitive traits are added to this scope.
- Use four fictional candidates per pipeline for S1. Empty stages are valid. Real
  records retain the selected CRM's identity and must not be mixed across organizations.
- The source brief requires stage display and pipeline switching, not unrestricted
  drag-and-drop CRM updates. Any later stage mutation goes through S3 approval.

### R7. GTM overview

- Name the page “GTM overview” consistently. Explain it as “A high-level view of
  outreach, relationships, and next actions across campaign and CRM systems.”
- Campaign tools supply activity, engagement, replies and follow-up timing. The CRM
  remains the durable relationship record for owner, stage, history and next action.
- Qualified campaign signals reconcile into CRM without duplicate records. Real
  reconciliation is an external mutation and is not enabled during S1/S2; S3 must
  provide explicit reviewed mapping and source-specific idempotency/recovery.
- Fixture relationships cover a warm community partnership, a commercial meeting
  requiring preparation, and a target-account cohort needing campaign review.
- Selecting a relationship updates its contextual email draft. Source cards show how
  CRM, campaign, Slack and Discord context inform it, with provenance on every excerpt.
- Provide “Review in email” and “Inspect sources”. Review may open a local artifact
  or the explicitly selected provider draft flow; it is never an implicit send.
- Changed selection must not overwrite an edited draft or apply a stale async result.

### R8. Collaboration

- Use “Team collaboration” and explain that decisions, owners and handoffs stay
  attached to work. Do not introduce a separate unstructured team-chat backend.
- Shared workstreams contain responsible people, current status and linked context.
  Fixtures cover product readiness, customer conversation and community event planning.
- A decision room presents the question, owners and project/calendar/Slack evidence;
  provide “Open decision” and “Share brief”.
- Show team focus and subtle availability; unknown availability must not look online.
- Recent handoffs show the work, requester, recipient, state and source context.
- Include “Hand off work with its context…” with Assign, and All teams / My work.
- Sharing/assigning must preview recipients and shared content, validate their access,
  and preserve work on failure. Unconnected fixture roles are never contactable users.
- Read audience, run authority, approval authority and connection ownership are separate.
  Team display must not imply all members can read sources, run agents or approve actions.

### R9. Workflows

| Example | Relevant sources | Prepared result |
| --- | --- | --- |
| Draft a high-context email | Email, Calendar, Drive | Editable draft with context and review action |
| Prepare a commercial meeting | Calendar, meeting notes, Drive | Meeting brief with priorities and evidence |
| Move a candidate forward | Meeting notes, CRM, Email | Human-reviewed recommendation and follow-up draft |
| Create a weekly executive brief | Projects, Slack, Calendar | Source-linked summary of decisions, owners and risks |

Both widget examples and the Workflows page must reach the same underlying flow.
Selecting an example must show a useful answer/artifact, contributing specialists,
supporting sources, next action and review boundary. Creating or selecting a saved
workflow must not itself schedule recurring execution.

### R10. Visual quality, interaction and surface parity

- Follow approved Matrix branding, `DESIGN.md`, shared brand tokens and existing
  window/overlay primitives. Warm off-white surfaces, forest-green primary actions,
  restrained lime accents, modern sans-serif typography, fine borders, modest radii,
  gentle shadows and monochrome/line icons express the requested direction.
- Preserve the user's wallpaper and other desktop preferences. The recording's
  wallpaper, specific dates, names and metrics are not a fixed product theme or dataset.
- Avoid emoji-style application icons, neon science-fiction styling, oversized marketing
  heroes, permanent logo walls, a dominant chat transcript, and disconnected metric grids.
- Every section's first viewport exposes useful work and an actionable next step.
- All controls have semantic names, keyboard access, visible focus, readable contrast,
  Escape/dismiss behavior and focus return. Respect reduced motion. At narrow sizes,
  stack panels rather than clip content or create unintended horizontal scrolling.
- Loading, empty, partial, offline, reconnecting, permission denied, unavailable source,
  interrupted run and failed action states must share copy and recovery semantics.

| Surface | Required product semantics | Presentation / release boundary |
| --- | --- | --- |
| Web Desktop | R1-R9 and all state/evidence/approval rules | Compact widget and expanded window; S1-S3 target |
| Electron Desktop | Same as Web Desktop | Shared UI with trusted transport/chrome adapters; S1-S3 target |
| Web Canvas | Same as Web Desktop | Proposed viewport-anchored widget plus Canvas window; preserve Canvas pan/zoom and independent geometry |
| Web Mobile | Same information/actions when enabled | Responsive entry and single-panel navigation; S1 includes responsive validation; connected release gated by equivalent tests |
| Native Mobile | Same information/actions when capability is enabled | Native input/navigation adaptation needs an explicit delivery decision; no Company OS launcher/capability is advertised until parity is verified |

Native Mobile's absent design is not a permanent exemption. D8 must record its delivery
packet or an approved temporary limitation before a connected launch. Presentation
switches must retain selected workspace, work item, draft, run and approval identity.

## Proposed data, security and execution contracts

These are release constraints for future implementation. No new endpoint is introduced
by this documentation change; exact methods, paths, Zod payloads and capability names
must be frozen in the S2/S3 contract packet before route implementation.

### Ownership and durable state

Source tools remain authoritative for their records. Company OS owns only its
configuration, authorized references/projections, artifact revisions, decisions,
handoffs, job cursors and action receipts. New durable app/agent orchestration data
uses owner-controlled Postgres via Kysely; inspectable agent/config exports reuse
existing file-owned definitions. Do not extend the in-memory readiness service into
a canonical shared database or create another provider transcript store.

Proposed records must carry owner/scope, stable identity, revision and provenance:
workspace profile; selected source connection; evidence reference; priority item;
canonical run reference; prepared artifact; proposed action; decision/handoff. An
action additionally binds actor, approver, connection owner, target, immutable payload
digest, evidence revision, expiry, idempotency key and eventual execution receipt.

Related record, audit and outbox writes commit in one transaction. Revision checks
belong in the write predicate. Upserts use scoped unique constraints. Network requests
run outside database transactions. External success with an unrecorded local receipt
is an uncertain operation to reconcile, not permission to send again.

### Authorization matrix and policy gap

| Operation / existing seam | Authentication and authorization | Required boundary |
| --- | --- | --- |
| Existing `GET /api/chat-agents/recipe-catalog` and Agent reads | Existing authenticated request principal and owner rules | Metadata/authorized definitions only; no automatic run |
| Existing `/api/company-brain/readiness` and `/context` | Existing authenticated owner-scoped routes | Not shared durable context; `visibility` text is not a grant |
| Selected integration metadata/reads | Existing authenticated integration transport plus current actor, owner and resource checks | Explicit selected account; no cross-account fallback or UI credentials |
| Future priorities, directory, hiring, drafts and evidence reads | Authenticated principal plus current workspace/resource/source access | Recheck evidence at read time; no public content route |
| Future run submission | Same scope checks plus owner-selected provider and enforced read capabilities | Child agents, tools, terminal and alternative transports cannot bypass read-only mode |
| Future decision, handoff and share writes | Current resource write authority plus validated recipient audience | No private context widening through summaries or notifications |
| Future action review/approval | Designated approver with authority over target and connection | Approval binds exact revision, recipient/target and payload; broad membership is insufficient |
| Future execution | Trusted scoped executor revalidates approval, source, membership, expiry and policy | Only approved immutable operation; uncertain outcome blocks blind retries |
| Optional scheduled refresh | Owner-scoped durable job with still-valid consent and capabilities | Same read checks; no implicit recurring outbound approval |

Organization collaboration V1 permits some contributor actions through owner connections
without per-operation approval. Company OS must not reuse that path as proof of its own
approval guarantee. S2 begins with an owner-only read pilot. Shared Company OS execution
and all outbound tools remain disabled until enforced capability restrictions and an
explicit compatible policy are accepted. A prompt saying “ask first” is insufficient.

Prototype controls cannot access real connector clients. S2 must deny write tools,
including indirect shell/network paths. If a harness cannot enforce this, it is not
eligible for the read-only pilot. Approval UI does not grant broader data access.

### Privacy, validation and lifecycle

- Documents, emails, meetings and tool results are untrusted data, never authority
  to change scope, reveal credentials, choose recipients or approve an action.
- Authenticate before lookup; validate identifiers, pagination, source references,
  target audiences and per-action payloads with bounded strict Zod schemas. Add Hono
  body limits before buffering every mutation, including DELETE.
- Provider credentials remain in the existing authorized connector boundary, never
  in the renderer, source excerpts, model prompts, analytics or published fixtures.
  Document external model/connector/speech processors and minimize transmitted content.
- Do not infer private profiles or search for real people to fill example content.
  Hiring assistance remains informational and human-reviewed.
- Source revocation immediately removes eligibility for new retrieval/actions and
  invalidates affected pending actions. Retained artifact visibility must follow its
  own current audience policy, including removal/redaction of no-longer-authorized excerpts.
- Owners can inspect/correct context and export/delete owned Company OS data. Forget
  and correction must survive subsequent imports; resolve retention and tombstone
  policy with ENG-1 before enabling durable memory ingestion.
- Server-side user-controlled source links require SSRF protection and redirect
  revalidation or rejection. UI links use safe protocols and source-checked destinations.
- Client errors are bounded, generic and actionable; logs retain redacted diagnostics
  without source bodies, credential values or private path disclosure.

### Limits and failure handling

Proposed initial bounds, to validate before S2: 32 KiB JSON mutation bodies, 100 rows
per page, 50 evidence references and 64 KiB total text per admitted context, four
concurrent source reads per workspace, one active refresh per selected source, and
two active master runs per workspace. Use bounded queues with visible backpressure.
Do not silently truncate input into a definitive answer; surface partial coverage.

External API calls use ten-second timeouts and downloads thirty seconds. Speech uses
the accepted platform speech limits; its exact audio duration/byte quotas must be
documented before enabling capture. Derived metadata caches cap at 256 workspace
entries with five-minute TTL and LRU eviction; they never cache approval authority.

Persist refresh cursors and leases; checkpoint each source page atomically. Resume
reads with capped backoff and visible last-success/next-attempt state. Real action
states distinguish draft, awaiting review, approved, executing, succeeded, failed,
expired, cancelled and outcome unknown. Cancellation after dispatch never claims to
undo a completed provider action. Deduplicate by stable source/operation identity.

Source failure must not erase drafts. Async completions are fenced by scope and
revision so late results cannot replace another selection. On permission changes,
hide unauthorized content and reject pending writes. Recovery after a crash restores
durable state, marks non-resumable runs interrupted and reconciles uncertain mutations.

Any new subscription registry needs connection caps, stale-subscriber eviction and
shutdown drains; reuse existing realtime transport where possible. Temporary media
requires recurring symlink-safe cleanup (proposed maximum TTL one hour after processing,
with earlier deletion on cancel). Shutdown aborts reads, clears timers, drains listeners,
releases leases and destroys only owned database resources. The implementation packet
must turn every proposed bound into a tested constant or justify a reviewed replacement.

## Acceptance

A first-time user must be able to explain that Company OS coordinates context and
work across tools, immediately find an important decision and its owner, navigate all
six sections, understand CRM/campaign roles, see how team context shaped a draft,
distinguish connected information from examples, and understand the approval boundary.

The [delivery plan](./plan.md) maps R1-R10 to testable scenarios and unresolved decisions.
S1 usability approval, S2 actual source/run evidence and S3 actual approved effects
are separate acceptance events. Neither a screenshot nor this spec PR proves a
working connector, agent, background job or production-ready feature.
