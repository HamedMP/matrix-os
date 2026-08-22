# Feature Specification: Self-Building Personal and Company Knowledge OS

**Feature Branch**: `115-knowledge-engine-demo`
**Created**: 2026-08-20
**Status**: Draft
**Input**: User description: "Make Matrix automatically build a private personal second brain and a separate company brain, then demonstrate polished Codex and Claude desktop parity, integrations, multiple agents, and app building across personal, company, and engineering-team launch stories. Collaboration follows in the next feature."

## Product Intent and Scope

Matrix becomes the trusted knowledge operating system that continuously turns a user's authorized tools and files into useful, evidence-backed people, projects, decisions, commitments, and work views. Matrix owns the durable knowledge, identity, permissions, provenance, search, approvals, and audit history. Codex, Claude, Hermes, Pi, and later runtimes are interchangeable workers that operate through Matrix-owned Chats and policies; none of them becomes the knowledge source of truth.

This feature has two sealed ownership planes that share product behavior without sharing content or credentials:

- **Personal Brain**: private to one person and built from personal sources, Matrix content, and approved files.
- **Company Brain**: owned by one organization and built from company sources under organization permissions.

The **Engineering Team** experience is a focused Company Brain setup for repositories, issues, pull requests, incidents, decisions, documentation, and delivery work. It is not a third ownership plane.

The launch acceptance surface is a clean, reproducible demonstration with three stories:

1. A private person connects life and work sources, receives a cited daily operating view, delegates work to multiple agents, and builds a useful personal app from that knowledge.
2. A company operator connects company systems, investigates a launch risk with evidence, reviews proposed actions, and builds an operating app from company knowledge.
3. An engineering lead uses Codex and Claude with equivalent Matrix desktop workflows, developer integrations, and app building while preserving project, approval, and review context.

Real-time human collaboration, comments, simultaneous editing, and shared presence are intentionally deferred to the next feature. This feature still establishes organization ownership, roles, access boundaries, and auditable agent actions so collaboration can be added without changing the data boundary.

## Launch Parity Baseline

"Codex and Claude desktop parity" means functional parity inside Matrix for the launch-critical workflow, not pixel imitation or exposure of provider internals. Both providers must participate in the same Matrix-owned Chat, project, run, approval, review, and notification model while provider-specific capabilities are shown honestly.

The dated launch baseline must be refreshed immediately before release against the official Codex and Claude product documentation. The 2026-08-20 baseline includes:

- projects and local or remote working contexts;
- persistent chats, history, search, pinning, archive, resume, cancel, and retry;
- parallel long-running work across separate tasks without corrupting project state;
- provider, model, and reasoning or planning controls when supported;
- files, attachments, multiple repositories, project instructions, and reusable skills;
- rich messages, code, tool progress, terminal activity, questions, approvals, and attention states;
- file and diff review, inline feedback, source-control status, pull-request review, and safe handoff to an editor or browser;
- isolated work, checkpoints or recoverable change boundaries, and clear rollback choices;
- scheduled or triggered automations with a review queue;
- notifications and continuation from another authorized Matrix shell without losing canonical context; and
- explicit capability labels where one provider does not support an equivalent operation.

Baseline references: [OpenAI Codex app](https://openai.com/index/introducing-the-codex-app/), [OpenAI desktop workflow update](https://openai.com/index/chatgpt-for-your-most-ambitious-work/), [OpenAI remote Codex](https://openai.com/index/work-with-codex-from-anywhere/), [Claude Code on desktop](https://www.anthropic.com/news/claude-opus-4-5), and [Claude Code autonomous workflows](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build a Private Second Brain Automatically (Priority: P1)

A person connects selected personal sources and Matrix automatically turns the authorized material into a useful private system of people, projects, commitments, events, claims, and cited pages without requiring manual filing.

**Why this priority**: The product wedge is a private brain that becomes useful from the tools the person already uses. Without trustworthy automatic organization, the rest is only a chat interface.

**Independent Test**: Connect a representative personal mailbox, calendar, drive, Matrix Notes, and files; complete an initial sync; then verify that Today, People, Projects, and Commitments are populated, deduplicated, private, and traceable to exact source evidence.

**Acceptance Scenarios**:

1. **Given** a person authorizes Gmail, Calendar, Drive, Matrix Notes, and selected files, **When** initial setup completes, **Then** Matrix shows a sync receipt and a useful Today view containing cited people, projects, meetings, and commitments.
2. **Given** the same person appears under different names or addresses, **When** Matrix organizes the material, **Then** it proposes or applies a reversible identity match without duplicating the person's history.
3. **Given** an extracted statement lacks strong evidence or conflicts with another source, **When** Matrix displays it, **Then** it is marked uncertain or conflicting and links to the relevant evidence instead of being presented as settled fact.
4. **Given** a source changes after the initial sync, **When** incremental synchronization runs, **Then** Matrix updates affected knowledge, records what changed, and does not duplicate unchanged items.
5. **Given** the user disconnects a personal source, **When** an agent later searches or acts, **Then** the revoked source is no longer available for new access and Matrix explains the safe recovery or retention state.

---

### User Story 2 - Operate a Personal Brain with Multiple Agents (Priority: P1)

A person asks Matrix to prepare for a meeting, track commitments, draft a follow-up, and delegate supporting work to specialist agents while Matrix keeps one coherent, evidence-backed task history.

**Why this priority**: The brain creates value when it helps the owner act, but trust requires visible evidence, clear agent roles, and approval before external consequences.

**Independent Test**: Ask Matrix to prepare for a meeting from personal sources, delegate research and scheduling checks to separate agents, review one flagged uncertainty, and approve a drafted follow-up without losing the canonical Chat or citations.

**Acceptance Scenarios**:

1. **Given** a meeting and related person exist in the Personal Brain, **When** the owner asks for preparation, **Then** Matrix returns a concise brief with commitments, recent context, open questions, and source citations.
2. **Given** the task benefits from specialists, **When** Matrix delegates research, scheduling, or drafting, **Then** the owner can see each agent's role, status, output, and relationship to the parent task.
3. **Given** an agent drafts an email or calendar change, **When** it is ready, **Then** Matrix shows the exact proposed action and requires the owner to approve it before execution.
4. **Given** the owner changes from Claude to Codex or another worker for the next step, **When** work continues, **Then** the Matrix Chat and committed history remain stable while a new provider-specific run begins from allowed canonical context.

---

### User Story 3 - Build and Operate a Sealed Company Brain (Priority: P1)

A company operator connects authorized work systems and receives an organization-owned view of decisions, customers, projects, commitments, risks, and conflicting evidence that never silently reaches into personal data.

**Why this priority**: Company knowledge must survive individual tools and employees while remaining permission-aware, auditable, and separate from personal life.

**Independent Test**: Connect representative Slack, GitHub, Linear, Drive, Calendar, and meeting-note sources to a company space; ask why a launch may slip; verify the answer cites multiple systems, exposes a conflict, and cannot retrieve personal email.

**Acceptance Scenarios**:

1. **Given** authorized company sources contain launch discussions, issues, pull requests, documents, and meetings, **When** the operator asks why the launch may slip, **Then** Matrix returns a prioritized risk view with a citation for every material claim.
2. **Given** Slack discussion conflicts with an approved decision record, **When** Matrix synthesizes the topic, **Then** it presents the conflict and the authority of each source rather than silently choosing one.
3. **Given** an agent proposes updates to a decision page, issue tracker, or company message, **When** the proposal is ready, **Then** an authorized approver sees a bounded diff, affected destinations, and expected effects before execution.
4. **Given** a company agent asks for information that exists only in the operator's Personal Brain, **When** the request runs, **Then** access is denied and no personal content, citation, or existence signal is revealed.
5. **Given** the owner explicitly promotes a personal insight, **When** they review the promotion, **Then** Matrix shows the smallest company-safe copy, identifies removed personal references, requires approval, and creates a new company-owned object with promotion provenance.

---

### User Story 4 - Run an Engineering Team from Matrix (Priority: P1)

An engineering lead opens a company-owned engineering space, connects development systems, and uses Codex and Claude to plan, implement, review, and hand off work through one polished Matrix experience.

**Why this priority**: Engineering teams are the sharpest launch audience for proving desktop-agent parity, developer integrations, local execution, and app building in one coherent OS.

**Independent Test**: Select a project with multiple repositories, start separate Codex and Claude tasks, review live progress and permissions, inspect changes and pull-request context, provide inline feedback, and complete a handoff without leaving Matrix for routine supervision.

**Acceptance Scenarios**:

1. **Given** GitHub, Linear, documentation, and delivery sources are connected, **When** the lead opens an engineering project, **Then** Matrix shows current issues, decisions, pull requests, risks, environments, and relevant Chats in one project context.
2. **Given** Codex and Claude are authenticated and available, **When** the lead starts two independent tasks, **Then** both can run in parallel with isolated change boundaries, visible status, and no corruption of the selected project.
3. **Given** either provider needs permission or clarification, **When** the request arrives, **Then** Matrix raises one consistent attention state with provider identity, safe details, and an approve, deny, or answer action.
4. **Given** a run changes files, **When** the lead reviews it, **Then** Matrix provides file and diff navigation, inline feedback, test and terminal evidence, source-control status, and pull-request context appropriate to the provider's capabilities.
5. **Given** a run is interrupted, the app restarts, or the user switches Matrix shells, **When** the lead returns, **Then** the same Chat, committed messages, run outcome, pending attention, and recovery choices are available.
6. **Given** one provider lacks a capability offered by the other, **When** the lead selects that operation, **Then** Matrix explains the limitation and valid alternative without pretending parity or discarding work.

---

### User Story 5 - Build Apps from Personal or Company Knowledge (Priority: P1)

A user asks Matrix to build a real app or dashboard from the knowledge and integrations already available in the active space, previews it in Canvas first, and keeps its data and permissions inside that space.

**Why this priority**: App building turns knowledge into a purpose-built operating surface and demonstrates Matrix as an expanding OS rather than a fixed chat product.

**Independent Test**: Build one personal dashboard and one engineering or company dashboard from approved knowledge, preview each in Canvas and Desktop, verify the generated app uses only the active space's data, and recover cleanly from one failed build.

**Acceptance Scenarios**:

1. **Given** the Personal Brain contains people, projects, and commitments, **When** the owner asks for a personal operating dashboard, **Then** Matrix creates a real installable app with a clear build status, preview, and owner-controlled files.
2. **Given** the Company Brain contains launch risks and project data, **When** an authorized user asks for a launch-control app, **Then** Matrix creates an organization-scoped app that queries only allowed company knowledge and integrations.
3. **Given** the app needs integration capabilities, **When** it is prepared for first use, **Then** Matrix shows the requested permissions and requires the owner or organization authority to grant them explicitly.
4. **Given** a build or preview fails, **When** Matrix reports the result, **Then** it preserves the source, shows a safe actionable state, retries within a bounded policy, and never substitutes a fake or lower-quality app silently.
5. **Given** the app opens in Canvas or Desktop, **When** the user changes shell modes or restores the workspace, **Then** the app remains discoverable, correctly themed, and bound to the same owner space.

---

### User Story 6 - Deliver a Clean, Reproducible Launch Demo (Priority: P1)

A launch presenter can move through Personal, Company, and Engineering stories without secret setup, stale windows, confusing provider chrome, or manual data repair, while every visible claim is backed by real product behavior.

**Why this priority**: The launch is the first proof that these capabilities form one OS. A brittle or fake-only path would undermine the trust promise.

**Independent Test**: Starting from a documented demo-owned environment, run all three stories in sequence twice, including one provider interruption and one denied cross-space request, with no source edits, database intervention, or hidden terminal repair between runs.

**Acceptance Scenarios**:

1. **Given** the presenter starts from the documented demo reset point, **When** they enter Personal, Company, or Engineering, **Then** the active space, owner, connected sources, and agent identity are unmistakable.
2. **Given** the presentation uses Canvas first and then Electron Desktop, **When** windows, Chats, apps, approvals, and notifications are opened, **Then** layout, focus, restore behavior, and shared state remain coherent and polished.
3. **Given** a sync, provider, integration, or app build is slow or unavailable, **When** the demo reaches that step, **Then** Matrix shows honest progress or a rehearsable recovery state rather than hanging, leaking internals, or presenting fabricated success.
4. **Given** the presenter repeats the demo, **When** the reset procedure runs, **Then** only synthetic demo-owned state is reset and no personal, customer, or production owner data is touched.

### Edge Cases

- The same contact, project, or commitment arrives from several sources with conflicting names, timestamps, or permissions.
- A source reports an edit, deletion, permission loss, or cursor reset after knowledge has already been derived from it.
- A citation points to content the current principal can no longer access.
- A source is connected through a third-party authentication path and the user mistakes "processed locally" for "direct local access."
- An agent-generated statement has no source, low confidence, or only cites another generated summary.
- Personal and company entities have similar names and an agent attempts to merge or search across spaces.
- A promoted personal insight contains quoted personal text, hidden recipients, or source links that company members cannot access.
- Two agents attempt related actions or file changes at the same time.
- A Chat changes project, provider, model, or execution root while a run is active.
- A provider supports chat but not approvals, worktrees, checkpoints, inline diff feedback, multiple repositories, or automation.
- A provider session expires while a run is waiting for approval or while the app is closed.
- The user switches runtime, account, space, or shell while a request is pending.
- An external action succeeds but the response is lost, or a retry repeats the request.
- A generated app requests data or integration access outside its active knowledge space.
- Canvas or Desktop restores a stale built-in, app, terminal, Chat, project, or notification reference.
- The demo network is degraded, a connector is rate-limited, or a live source changes during presentation.
- Synthetic demo data is accidentally mixed with a real account or production workspace.

### Assumptions

- The first launch presenter is a technical founder using three demo-owned spaces with synthetic or explicitly approved sample data.
- Personal and Company Brain share product concepts but have separate ownership, credentials, search, agent memory, and durable content.
- Engineering Team is a company-space configuration, not a third ownership category.
- Matrix-owned Chats are the durable user-facing task identity; provider sessions are run details and cannot replace that identity.
- Matrix Notes, Files, Chats, and user uploads are first-class sources alongside connected services.
- Initial durable personal sources are Gmail, Google Calendar, Drive or Docs, contacts, and Matrix-native content.
- Initial durable company and engineering sources are Slack, GitHub, Linear, Drive or Docs, Calendar, meeting notes, and Matrix-native content.
- Other connected services may be action-capable without becoming durable knowledge sources until a semantic sync contract exists.
- Provider-specific capability differences are acceptable when Matrix labels them honestly and preserves a complete provider-neutral core workflow.
- External sends, publishes, repository mutations, issue changes, and company knowledge updates require approval by default.
- The existing Canvas-first browser shell, Electron Desktop, canonical terminal sessions, shared built-ins, notification host, project lifecycle, file/drop behavior, and Matrix app runtime are foundations to extend, not parallel systems to replace.
- The provider-neutral Chat architecture is the target contract for durable Chat identity and cross-shell continuation.

### Out of Scope

- Real-time human collaboration, comments, presence, simultaneous editing, and shared cursor behavior.
- A general-purpose organization administration suite beyond the roles and permissions required to protect company knowledge and approve actions.
- Ingesting every service available through the integration catalog as durable knowledge.
- Fully autonomous external writes, sends, publishes, merges, deployments, or permission changes without an applicable approval policy.
- Banking, personal financial accounts, medical records, or other specially regulated personal-data ingestion for launch.
- A full visual knowledge-graph canvas.
- Replacing the existing rich-text editor solely for this feature.
- Replacing Codex, Claude, Hermes, or Pi with a new Matrix agent runtime.
- Treating provider memory, generated prose, or conversation summaries as canonical knowledge without source evidence.
- A public app marketplace or public sharing flow for generated apps.
- Pixel-for-pixel imitation of Codex or Claude branding and provider-specific chrome.

## Requirements *(mandatory)*

### Functional Requirements

#### Knowledge ownership and automatic organization

- **FR-001**: Matrix MUST provide Personal and Company knowledge spaces with separate ownership, credentials, content, agent memory, search, and audit history.
- **FR-002**: Matrix MUST treat Engineering Team as a Company knowledge-space configuration and MUST NOT introduce a third ownership plane.
- **FR-003**: Matrix MUST derive the active owner and space from the authenticated Matrix context and MUST NOT trust a client-supplied owner scope.
- **FR-004**: Matrix MUST make the active space and owner boundary visible anywhere knowledge, integrations, agents, approvals, or generated apps are used.
- **FR-005**: Matrix MUST automatically organize authorized source material into documents, people, organizations, projects, topics, commitments, tasks, decisions, claims, citations, pages, and views.
- **FR-006**: Matrix MUST preserve source identity, source location, observed time, permission scope, and extraction state for every durable derived claim.
- **FR-007**: Matrix MUST distinguish human-authored content, source-derived content, agent proposals, approved content, and generated projections.
- **FR-008**: Matrix MUST NOT overwrite human-authored content automatically; proposed changes MUST remain reviewable and reversible.
- **FR-009**: Matrix MUST detect likely duplicate entities and provide reversible resolution with visible source evidence.
- **FR-010**: Matrix MUST surface stale, low-confidence, contradicted, or inaccessible claims instead of presenting them as settled facts.
- **FR-011**: Matrix MUST provide full-text and meaning-based retrieval filtered by the current principal's space and source permissions.
- **FR-012**: Matrix MUST provide deterministic export and owner-requested deletion for Personal knowledge and organization-authorized export and deletion for Company knowledge.

#### Sources, synchronization, and provenance

- **FR-013**: Matrix MUST show whether each source is direct local, locally processed through an authentication or transit provider, or externally processed.
- **FR-014**: Matrix MUST distinguish a service that agents can call from a service that has a durable knowledge synchronization contract.
- **FR-015**: Matrix MUST provide durable synchronization for the launch sources named in Assumptions, including pagination, incremental progress, retries, deduplication, edits, deletions, and permission changes.
- **FR-016**: Matrix MUST show a bounded sync receipt with source, last successful progress, processed counts, failures, and next recovery action without exposing secrets or raw provider errors.
- **FR-017**: Matrix MUST preserve immutable source evidence needed to explain derived knowledge while honoring source deletion, owner deletion, and retention policy.
- **FR-018**: Matrix MUST link every material brief, answer, decision, risk, or commitment to accessible source evidence.
- **FR-019**: Matrix MUST prevent citations to one generated summary from being treated as independent evidence for another durable claim.
- **FR-020**: Matrix MUST re-evaluate affected knowledge when a source object changes, disappears, loses permission, or conflicts with a more authoritative source.
- **FR-021**: Matrix MUST stop new access through a revoked connection immediately and show an owner-visible retention or cleanup state for previously synchronized material.
- **FR-022**: Matrix MUST keep sync, parsing, deduplication, and cursor management deterministic and observable rather than delegating correctness to an unconstrained agent.

#### Personal, company, and promotion workflows

- **FR-023**: Matrix MUST provide a Personal Today view covering commitments, meeting preparation, follow-ups, and at-risk projects with citations.
- **FR-024**: Matrix MUST provide Personal views for People, Projects, Commitments, and source-backed pages.
- **FR-025**: Matrix MUST provide Company views for Decisions, Customers, Projects, Risks, Commitments, Conflicts, and operating reviews.
- **FR-026**: Matrix MUST propagate source access restrictions into Company retrieval, citations, agent context, and generated views.
- **FR-027**: A Company agent MUST never query, infer, enumerate, or reveal the existence of Personal content directly.
- **FR-028**: Matrix MUST provide an explicit Promote to Company flow that minimizes content, removes inaccessible personal references, shows a diff, requires approval, and creates a new company-owned object with promotion provenance.
- **FR-029**: Promotion MUST NOT move or reclassify the original Personal object.

#### Provider-neutral Chats, agents, and desktop parity

- **FR-030**: Matrix MUST keep one durable Chat identity across shells and future provider selections while recording each Codex, Claude, Hermes, Pi, or other execution as a distinct run.
- **FR-031**: Matrix MUST preserve committed canonical Chat history independently of provider-native session state.
- **FR-032**: Matrix MUST allow only same-provider, compatible-session resume; changing providers MUST start a new run from allowed canonical context or an explicit fork.
- **FR-033**: Matrix MUST provide equivalent core Codex and Claude workflows for starting, streaming, pausing, resuming, cancelling, retrying, and reviewing long-running work.
- **FR-034**: Matrix MUST support parallel independent runs with isolated project or change boundaries and visible parent-child task relationships.
- **FR-035**: Matrix MUST show the actual provider, model, reasoning or planning mode, project context, run state, and capabilities used for each run.
- **FR-036**: Matrix MUST provide persistent Chat list, search, pin, archive, delete, project assignment, and safe active-run lifecycle behavior.
- **FR-037**: Matrix MUST support project files, bounded attachments, project instructions, and multiple repositories where the selected provider supports them.
- **FR-038**: Matrix MUST render rich assistant content, code, tool activity, terminal progress, questions, approvals, errors, and completion state without exposing credentials or raw internal diagnostics.
- **FR-039**: Matrix MUST provide file and diff review, inline feedback, test evidence, source-control status, and pull-request context for provider runs that change code.
- **FR-040**: Matrix MUST provide recoverable change boundaries through isolated work, checkpoints, version control, or another clearly explained rollback mechanism appropriate to the provider.
- **FR-041**: Matrix MUST expose provider-specific skills, hooks, subagents, automations, and other capabilities through a bounded, capability-driven catalog rather than hard-coded provider assumptions.
- **FR-042**: Matrix MUST label unsupported provider capabilities and offer a valid alternative without silently changing provider or execution scope.
- **FR-043**: Matrix MUST surface approval-required, input-required, failed, completed, and automation-review attention consistently across Canvas, Electron Desktop, and other authorized Matrix shells.
- **FR-044**: Matrix MUST restore the canonical Chat, committed messages, active or terminal run state, project context, and unresolved attention after application restart or authorized shell change.
- **FR-045**: Matrix MUST maintain a dated parity checklist against current official Codex and Claude desktop capabilities and refresh it immediately before launch acceptance.

#### Integrations, proposals, and actions

- **FR-046**: Matrix MUST let users connect services once and grant bounded read or action capabilities to a specific Personal or Company space.
- **FR-047**: Matrix MUST show connected, setup-required, revoked, degraded, unavailable, and privacy-processing states for every integration used in the launch stories.
- **FR-048**: Matrix MUST allow agents to search and read only the sources and actions authorized for the active principal and space.
- **FR-049**: Matrix MUST represent externally consequential work as a proposal containing the exact action, target, material inputs, expected effects, and relevant evidence.
- **FR-050**: Matrix MUST require an authorized human approval before external sends, publishes, repository mutations, issue updates, deployment actions, or durable company-knowledge changes unless an explicit narrower policy has already approved that exact action class.
- **FR-051**: Matrix MUST make approval and execution separate, auditable states and MUST prevent duplicate execution during retries or lost responses.
- **FR-052**: Matrix MUST record who proposed, approved, rejected, executed, or cancelled an action and when it occurred.
- **FR-053**: Matrix MUST allow an owner or organization authority to revoke a capability and stop future use without deleting unrelated owner data.
- **FR-054**: Matrix MUST return safe, actionable errors and MUST NOT expose credentials, provider internals, private paths, database details, or another space's existence.

#### App building

- **FR-055**: Matrix MUST let a user request, build, preview, revise, and install a real app from within the active Personal or Company space.
- **FR-056**: Generated app files and app data MUST belong to the active owner space and remain exportable and deletable by that owner.
- **FR-057**: Generated apps MUST declare their knowledge, file, network, notification, and integration permissions before first use.
- **FR-058**: A generated app MUST NOT access Personal knowledge from a Company space or Company knowledge from a Personal space without an explicit supported transfer flow.
- **FR-059**: Matrix MUST show build, test, preview, repair, ready, and failed states with bounded retry and a safe recovery action.
- **FR-060**: Matrix MUST preserve the requested app quality and capability target when repairing a build and MUST NOT silently replace it with a fake, static screenshot, or unrelated simpler artifact.
- **FR-061**: Generated apps MUST work in Canvas first and remain usable, discoverable, and correctly themed in Desktop mode.
- **FR-062**: The Personal demo MUST build a personal operating dashboard, and the Company or Engineering demo MUST build a company-owned operating or engineering dashboard from the same governed knowledge paths used elsewhere in Matrix.

#### Launch-demo quality and continuity

- **FR-063**: Matrix MUST provide documented, synthetic, demo-owned Personal, Company, and Engineering scenarios that exercise production product paths rather than fake-only presentation components.
- **FR-064**: Each scenario MUST have a safe reset that targets only its exact demo-owned state and cannot touch production or unrelated owner data.
- **FR-065**: The presenter MUST be able to identify the active owner space, source privacy mode, provider, project, and approval boundary at every material transition.
- **FR-066**: The demo MUST use Canvas as the primary browser experience and MUST also validate Electron Desktop without creating divergent Chat, project, app, terminal, or notification state.
- **FR-067**: Existing shared built-ins, canonical terminal sessions, project lifecycle, drag-and-drop, paste, notification layering, window focus, restore behavior, and app discovery MUST remain consistent in both Canvas and Desktop.
- **FR-068**: Demo-critical progress MUST never hang indefinitely; slow work MUST show visible progress, timeout, and a rehearsable recovery path.
- **FR-069**: The launch flow MUST be operable without hidden source edits, direct database changes, SSH repair, or presenter-only secret commands between stories.
- **FR-070**: The demo MUST include one denied Personal-to-Company access attempt, one explicit promotion, one approval before external action, one provider interruption and recovery, and one generated app preview.
- **FR-071**: Matrix MUST support reduced motion, keyboard operation, readable focus, sufficient contrast, and stable layout across the demo's supported desktop viewport sizes.

#### Security, limits, and operational safety

- **FR-072**: Every knowledge read, sync, proposal, approval, execution, promotion, export, and delete operation MUST authenticate the principal and authorize the active space and source scope.
- **FR-073**: All user, provider, connector, file, URL, query, and agent-produced inputs MUST be validated and bounded before storage, retrieval, rendering, or action.
- **FR-074**: External calls MUST have bounded timeouts and safe retry behavior; retries MUST NOT duplicate source objects, runs, proposals, approvals, or external actions.
- **FR-075**: Searches, result pages, source objects, attachments, agent events, concurrent runs, subscribers, temporary exports, and retained demo artifacts MUST have explicit limits and cleanup behavior.
- **FR-076**: User-controlled remote locations MUST be screened against private or internal targets and unsafe redirects before server-side access.
- **FR-077**: Raw provider, connector, filesystem, database, network, credential, and path errors MUST remain in owner-controlled diagnostics and MUST NOT reach user-visible clients.
- **FR-078**: Related durable writes, including an action and its audit record or a claim and its citation, MUST complete atomically or leave a documented recoverable state.
- **FR-079**: Agent and integration registries MUST evict stale entries, survive restart, and drain active subscribers or runs safely during shutdown.
- **FR-080**: Company access and approval roles for this feature MUST be owner, admin, member, and viewer, with the least privilege needed for each operation.

#### Knowledge workspace and initial agent roles

- **FR-081**: Authored pages MUST preserve stable block identity so links, citations, proposals, and corrections remain attached to the intended content as a page evolves.
- **FR-082**: Matrix MUST support linked pages, backlinks, entity mentions, and suggestions for relevant unlinked mentions without creating relationships silently.
- **FR-083**: Pages MUST support properties, tasks, owners, due dates, and commitment state that can be viewed and updated without flattening them into prose.
- **FR-084**: Users MUST be able to view the same authorized knowledge as pages, tables, boards, calendars, and timelines without creating separate conflicting copies.
- **FR-085**: Pages, briefs, and views MUST provide an evidence surface that shows the exact source, citation, confidence, and conflict state behind selected content.
- **FR-086**: Authored pages MUST have one canonical editable representation and a deterministic portable Markdown export; Matrix MUST NOT maintain two independently editable truths for one page.
- **FR-087**: The first agent set MUST cover curation, personal chief-of-staff work, company knowledge stewardship, customer intelligence, project operation, policy and audit, and app building, with each role's scope visible to the user.
- **FR-088**: Matrix MUST keep tools, reusable skills, agents, and triggers distinguishable so users can tell what primitive ran, which workflow guided it, which actor made a decision, and what event started the work.
- **FR-089**: The Personal Brain MUST support scheduled daily and weekly review workflows that land in a reviewable queue and never execute consequential actions silently.
- **FR-090**: Any agent-proposed change to a reusable skill, agent definition, or provider-native memory MUST include a reviewable diff, validation evidence, and approval before it becomes active.

### Access and Action Matrix

| Operation | Personal owner | Company owner/admin | Company member | Company viewer | Agent/runtime |
|---|---|---|---|---|---|
| View and search allowed knowledge | Own Personal space | Allowed Company scope | Allowed Company scope | Read-only allowed Company scope | Only delegated principal scope |
| Connect or revoke a source | Yes | Yes | No by default | No | Never autonomously |
| Create or edit authored knowledge | Yes | Yes | Yes when granted | No | Proposal only by default |
| Propose an external action | Yes | Yes | Yes when granted | No | Yes within delegated capabilities |
| Approve or execute an external action | Yes | Yes | Only when explicitly granted | No | Execute only after valid approval or policy |
| Promote Personal insight to Company | Initiates and approves Personal disclosure | Accepts Company copy | No by default | No | May draft sanitized proposal only |
| Export or delete the whole space | Yes | Yes | No | No | Never |
| Manage Company roles and retention | Not applicable | Yes | No | No | Never |

### Key Entities *(include if feature involves data)*

- **Knowledge Space**: The sealed Personal or Company ownership boundary for knowledge, credentials, permissions, agents, apps, and audit history.
- **Source Connection**: An authorized account or source with scope, sensitivity, processing-mode label, capability tier, and connection state.
- **Sync Receipt**: Bounded user-visible evidence of source progress, counts, failures, cursor state, and recovery.
- **Source Object**: An immutable observed version of an email, message, event, note, issue, pull request, file, meeting, or other authorized evidence.
- **Document**: A normalized, searchable representation of a source object that retains its provenance and permissions.
- **Entity**: A person, organization, project, product, customer, meeting, or topic resolved from one or more sources.
- **Claim**: A source-derived statement with evidence, confidence, validity, status, permissions, and correction history.
- **Citation**: The exact relationship from a claim, brief, page, or decision to accessible source evidence.
- **Commitment**: A promised action with owner, counterparty, due state, evidence, and completion status.
- **Decision**: An approved conclusion with authority, effective time, supersession state, and supporting evidence.
- **Page and View**: Human-authored knowledge plus generated projections such as Today, People, Projects, Decisions, Risks, tables, boards, calendars, and timelines.
- **Chat**: The durable Matrix-owned task and canonical conversation identity across shells and provider runs.
- **Agent Run**: One bounded execution attempt by a named provider with declared capabilities, context, state, output, and recovery information.
- **Agent Profile**: A visible Matrix-owned role, purpose, allowed tools and skills, active space, approval policy, and lifecycle state for one specialist agent.
- **Proposal**: A reviewable change or external action prepared by an agent but not yet executed.
- **Approval**: The authorized decision to accept, reject, or revise a proposal under a specific scope.
- **Audit Event**: A durable, owner-visible record of a security-sensitive knowledge, permission, approval, or execution transition.
- **Generated App**: Owner-controlled app source, build, manifest, permissions, data, and installed state derived through Matrix app building.
- **Demo Scenario**: Versioned synthetic source data, expected outcomes, reset scope, timing, and acceptance evidence for one launch story.

### Delivery Dependencies

- The provider-neutral Chat architecture must be approved and used as the durable target rather than creating a second provider-specific Chat identity.
- Launch parity must be checked against the current official Codex and Claude capability documentation immediately before acceptance.
- Implementation must follow test-first delivery with independently demoable slices and preserve all Matrix ownership, defense-in-depth, and Canvas-first shell invariants.
- User-facing behavior must be documented through a separate public documentation pull request in the private `FinnaAI/matrix-os-site` repository; no local public-site tree is added here.
- Collaboration requirements must be specified and delivered in a separate follow-up feature without weakening the sealed Personal and Company boundaries defined here.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new demo Personal space reaches a useful cited Today view from the launch source set within 10 minutes, without manual filing or operator repair.
- **SC-002**: In launch acceptance, 100% of material factual statements in generated briefs, decisions, risks, and commitments link to accessible source evidence or are visibly marked uncertain.
- **SC-003**: The personal meeting-preparation flow returns commitments, recent context, open questions, and at least one evidence link in under 30 seconds after synchronization is complete.
- **SC-004**: Repeating the same unchanged source sync creates zero duplicate source objects, entities, commitments, or decisions in the acceptance dataset.
- **SC-005**: The Company launch-risk question produces a prioritized answer grounded in at least four connected company source types and visibly identifies the seeded source conflict.
- **SC-006**: Every Company-agent attempt to access Personal content is denied without revealing content or existence in all boundary tests.
- **SC-007**: The Promote to Company rehearsal shows the exact company-safe copy, removes all seeded personal-only references, records provenance, and creates nothing until both disclosure and company acceptance requirements pass.
- **SC-008**: A launch user can start one Codex task and one Claude task in the same engineering project, supervise both in parallel, and reach a completed, failed, cancelled, or needs-input state without project corruption or duplicate active runs.
- **SC-009**: Codex and Claude each pass 100% of the common dated parity checklist; every provider-specific exception has a visible capability label and tested alternative.
- **SC-010**: After an application restart and an authorized shell change, all accepted Chats, committed messages, project links, run outcomes, and unresolved attention states in the rehearsal remain available and consistent.
- **SC-011**: Every consequential demo action presents a proposal and requires a valid approval before execution; duplicate retry tests produce exactly one external effect.
- **SC-012**: A personal operating dashboard and a company or engineering dashboard can each be requested, built, previewed, revised once, and reopened in Canvas and Desktop within 10 minutes using only their active space's authorized knowledge.
- **SC-013**: Generated-app boundary tests produce zero Personal-to-Company or Company-to-Personal data leaks and zero undeclared integration uses.
- **SC-014**: Each of the three launch stories completes within 12 minutes from its documented reset point, and the full sequence can be repeated twice without hidden repair or cross-scenario contamination.
- **SC-015**: Canvas-first and Electron Desktop visual acceptance finds no clipped text, overlapping controls, hidden primary actions, broken focus order, stale windows, competing notification stacks, or incorrect owner-space labels in supported launch viewports.
- **SC-016**: Every simulated connector, provider, network, build, and permission failure used in the rehearsal reaches a visible safe error or recovery state within its declared timeout and exposes no secret, private path, raw provider error, or other-space identifier.
- **SC-017**: An unfamiliar internal rehearsal user can correctly identify the active space, active provider, cited evidence, pending approval, and next action in at least 90% of tested demo checkpoints without presenter coaching.
- **SC-018**: The launch is not marked ready until the dated parity checklist, three scenario scripts, privacy-boundary tests, approval tests, app-build tests, Canvas and Desktop visual evidence, restart continuity, safe reset, and separate public-docs deliverable all have recorded passing evidence.
- **SC-019**: Every acceptance page preserves working backlinks, entity mentions, structured task properties, and citations after editing, and exports to portable Markdown with no loss of visible authored text or source references.
- **SC-020**: Each initial specialist agent is identifiable by role and active space at every launch checkpoint, and no proposed skill, agent-definition, or provider-memory change becomes active without a recorded diff, validation result, and approval.
