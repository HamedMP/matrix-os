# Feature Specification: Conversational Recipe Bots

**Feature Branch**: `codex/535-conversational-bots`
**Created**: 2026-09-26
**Status**: Proposed for review; specification only; spike not executed
**Input**: Recipes become persistent rabbit-avatar bots that users build through conversation, progressively connect to services, and invite into group chats to collaborate. Evaluate a Matrix-owned agent powered by Pi, including computer use, after this specification is published on GitHub.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Meet and Build a Bot Through Chat (Priority: P1)

A person chooses a recipe and immediately meets a named bot with its own rabbit avatar and direct conversation. They explain the job, refine its approach, and begin useful work in that conversation. There is no configuration form, mandatory questionnaire, model picker, or setup wizard in this journey.

**Why this priority**: The enduring relationship is the product. Recipe selection must create something the person can return to, even before all dependencies are connected.

**Independent Test**: Choose Personal Daily Brief, answer its first relevant question, close the app, and return to the same bot, identity, conversation, and remembered answer.

**Acceptance Scenarios**:

1. **Given** a recipe with several integrations, **when** the person selects it, **then** exactly one bot and its direct chat are created for that creation request; connection setup does not block creation. A deliberate second creation can create a separate bot.
2. **Given** the bot already knows a preference from this authorized conversation, **when** it needs that preference again, **then** it uses it without repeating the question; the person can correct it conversationally.
3. **Given** a new bot, **when** it starts onboarding, **then** it asks at most one blocking question at a time and explains the immediate purpose. Optional inline choices supplement ordinary text replies.
4. **Given** a bot has enough information for part of the job, **when** another part is blocked, **then** it offers or completes useful authorized work and identifies the gap without fabricating results.
5. **Given** a correction such as “only enterprise deals, and keep it short,” **when** the bot acknowledges it, **then** the preference is persisted with its scope and subsequent relevant work follows it.

### User Story 2 - Connect Services Gradually (Priority: P1)

A bot checks what the person has connected in Matrix and asks for additional access only when it becomes relevant to the work. Account choices and connection actions live inside the conversation.

**Why this priority**: A recipe may mention many integrations. Requiring all of them up front defeats collaborative setup.

**Independent Test**: Start with Gmail connected and Calendar disconnected; reuse the authorized Gmail account, decline Calendar, later connect Calendar from the same chat, and resume without rebuilding the bot.

**Acceptance Scenarios**:

1. **Given** an existing connection with an adequate bot grant, **when** the bot needs it, **then** it reuses it without requesting another login. A connected account without a bot grant requires conversational authorization.
2. **Given** multiple eligible accounts and no saved choice, **when** the bot needs a service, **then** it asks which account to use and does not silently choose one.
3. **Given** a missing dependency, **when** the bot requests it, **then** an inline Connect action explains the service, requested access, and immediate benefit. Provider-hosted login/consent may open externally; completion returns to the same conversation.
4. **Given** connection is declined, cancelled, expires, or fails, **when** the person continues, **then** the bot preserves its identity and work, offers a supported alternative, and does not repeatedly nag during the same task.
5. **Given** a successful connection or a later revocation, **when** the bot next acts, **then** it uses freshly verified access. A duplicated or stale completion cannot attach another person's account or start duplicate work.
6. **Given** the job evolves, **when** the bot needs an additional integration, **then** it requests it naturally in the existing conversation without restarting setup.

### User Story 3 - Work With Bots in a Group (Priority: P1)

A person creates a normal group chat with named bots and optionally other people. Bots are visible participants with their own rabbit avatars. They can be addressed, exchange authorized findings, delegate parts of a task, and produce a shared result.

**Why this priority**: Collaboration is a core requirement, including in the first spike; it is not a future substitute for independent bot chats.

**Independent Test**: Invite Research Rabbit and Brief Rabbit into a group. Ask Research Rabbit to investigate a competitor and Brief Rabbit to use its findings in a concise brief. Observe attributed contributions, an explicit handoff, and one verified final artifact.

**Acceptance Scenarios**:

1. **Given** two bots in a group, **when** the person mentions one, **then** that bot receives the request; the other does not automatically reply merely because a message appeared.
2. **Given** an unaddressed group task, **when** it is accepted, **then** one visibly identified coordinator owns it and delegates only as needed. The person can redirect ownership conversationally.
3. **Given** a delegated task, **when** a recipient bot works, **then** the group sees its attribution, task ownership, relevant progress, and linked result without private internal traces or repetitive chatter.
4. **Given** private direct-chat history or service data, **when** its bot joins a group, **then** that material remains private unless its owner explicitly shares a bounded item or authorizes a defined class of group output.
5. **Given** a group member without account-grant authority, **when** they request connected data, **then** the bot asks the authorized owner privately or reports the dependency; it does not expose account identifiers or grant access itself.
6. **Given** the owner stops the group task or removes a bot, **when** queued or running work is reconciled, **then** unauthorized future work and handoffs stop and already-posted group history remains attributed and readable to remaining authorized members.
7. **Given** bots could repeatedly delegate to each other, **when** the configured task budget is reached, **then** they stop and report the remaining work to the person.

### User Story 4 - Finish Work on a Persistent Computer (Priority: P1)

A bot can use connected services, websites, files, and a computer to complete an authorized job while the person is away. The person can inspect progress, take over for login, and stop execution.

**Why this priority**: The recipes describe completed work, not only generated advice.

**Independent Test**: Ask a bot to retrieve a document through a website with no connector, handle a visual dialog, save a brief, and show evidence that the saved artifact can be opened.

**Acceptance Scenarios**:

1. **Given** a job needs browser or desktop interaction, **when** the bot acts, **then** it can observe the resulting state, and the person can view activity and take over the same computer session.
2. **Given** a login challenge, expired session, or inaccessible application, **when** the bot cannot continue, **then** it requests human help with a clear next action and resumes after verified resolution.
3. **Given** the app closes or execution is interrupted, **when** the person returns, **then** the job either continues or shows a truthful recoverable/blocked state; uncertain external actions are reconciled before retrying.
4. **Given** an action exceeds existing authorization, **when** it is proposed, **then** the person sees the concrete recipient, change, or artifact before approval. Valid prior authorization is honored without redundant prompts.
5. **Given** a claimed result, **when** the bot marks the task done, **then** it includes evidence appropriate to the outcome: readable artifact, source link, observed external state, or executed check.

### User Story 5 - Grow a Bot Over Time (Priority: P2)

A person teaches a workflow, corrects a bot, or asks it to repeat successful work. The bot retains scoped preferences and can propose reusable skills and routines through conversation.

**Independent Test**: Correct a brief's style, demonstrate a repeatable website task, review the resulting skill, and explicitly schedule it; inspect the next run and then pause it conversationally.

**Acceptance Scenarios**:

1. A demonstration becomes an inspectable, editable skill after a validating replay; copying screen coordinates alone is insufficient.
2. Mentioning a routine in a recipe does not activate it. An explicit request captures timing, timezone, delivery destination, and authorized actions before activation.
3. Runs share bot identity and relevant authorized memory across direct and group chats without merging their private histories.
4. The person can inspect, correct, forget, export, pause, or archive the bot and its workflows through conversation, with visible confirmation of the actual result.

### Edge Cases

- Creation retried after a lost response; two devices edit one bot; creation interrupted between bot and chat persistence.
- Missing, expired, revoked, insufficient-scope, or ambiguous service accounts; forged OAuth completion; return to another chat.
- Bot archived while waiting; group membership revoked during execution; user takeover races a queued click.
- A webpage or email tells the bot to reveal credentials, change its role, or invite another bot.
- Integration succeeded but its response was lost; the provider cannot confirm whether a mutation happened.
- No suitable model, funds, computer capacity, or required application; disconnected service differs from an empty result.
- Unsupported telephony, home-device, media-generation, or proprietary application dependency.
- Old recipe versions, manually edited bot files, missing skills, and inaccessible artifacts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Selecting a recipe MUST create a durable bot identity and direct conversation idempotently, with a stable rabbit avatar and name.
- **FR-002**: Bot creation, personalization, dependency requests, routine setup, and changes MUST be achievable through chat without required configuration forms. External service login and consent are permitted.
- **FR-003**: Bots MUST preserve stated nuances and ask only relevant unanswered questions, at most one blocking question at a time.
- **FR-004**: Bots MUST discover connected services, distinguish connection from authorization, request missing access progressively, and ask about ambiguous accounts.
- **FR-005**: Connection and authorization outcomes MUST resume the original workflow safely, including after reconnect, cancellation, or duplicate completion.
- **FR-006**: Bots MUST be first-class participants in direct and group chats with distinct attribution, mentions, task ownership, and bounded delegation.
- **FR-007**: Group membership MUST NOT imply access to a bot's private memory, direct chats, credentials, or connected accounts. Sharing requires owner-authorized scope and audience.
- **FR-008**: Bots MUST support service operations, browser interaction, visual desktop interaction, files, and artifact verification according to declared capabilities; unavailable capabilities MUST remain explicit.
- **FR-009**: Long-running work MUST expose truthful state, interruption recovery, cancellation, and human takeover without repeating uncertain external effects.
- **FR-010**: Approval MUST apply to the exact proposed effect and audience, honor valid prior authorization, and be invalidated by material changes or revocation.
- **FR-011**: Bot definitions, preferences, reusable skills, and routines MUST remain owner-controlled and exportable; private and shared memories MUST retain separate scopes and provenance.
- **FR-012**: Learned workflows MUST be inspectable and replay-tested; routines MUST require an explicit user request and preserve timezone, access, and notification intent.
- **FR-013**: The complete existing recipe inventory MUST map to capability requirements and acceptance evidence. A catalogue entry or successful prompt alone MUST NOT be labeled functional parity.
- **FR-014**: Web Canvas, Web Desktop, and Electron Desktop MUST expose equivalent bot, integration, group, approval, and recovery behavior. Web Mobile and Native Mobile MUST share these semantics where Chat exists; viewport adaptations may differ.
- **FR-015**: Existing bots, rabbit identities, chats, artifacts, and explicit model/account choices MUST survive rollout. Migration MUST NOT silently reinterpret native execution checkpoints.
- **FR-016**: Missing service/model dependencies or policy failures MUST produce actionable generic states, never fabricated completion, raw secrets, or internal infrastructure details.

### Key Entities

- **Recipe**: versioned starting role, capabilities, suggested integrations and routines, output expectations, provenance, and acceptance examples.
- **Bot**: enduring owner-scoped identity, rabbit appearance, role revision, preferences, skills, and direct conversation.
- **Conversation / Participant**: direct or group history and authorized human/bot membership; participation is distinct from service authority.
- **Task / Handoff**: outcome, owning bot, parent task, recipient, authorized shared context, budget, status, and result.
- **Connection / Grant**: service account availability versus permission for a bot, action, and output audience to use it.
- **Pending Interaction**: question, account choice, connection request, approval, or takeover waiting on a specific authorized person.
- **Memory / Skill / Routine**: scoped remembered facts with provenance; reusable procedure; explicitly activated trigger and delivery policy.
- **Artifact / Evidence**: owner-scoped result and observations supporting its completion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All creation acceptance cases produce one persistent bot per creation request and require zero configuration-form fields.
- **SC-002**: All missing/connected/multiple-account/declined/revoked integration scenarios preserve the bot and return to the correct conversation without duplicate work.
- **SC-003**: A group with one person and two bots completes the research-to-brief scenario with correct attribution, one final artifact, and no repeated handoff cycle in three consecutive trials.
- **SC-004**: Browser and visual-desktop scenarios each complete three consecutive trials with an inspectable result; failed trials remain reported, not discarded.
- **SC-005**: Every injected interruption, cancellation, revocation, and unauthorized-group-read case produces a safe observable outcome with zero unauthorized effects in the acceptance suite.
- **SC-006**: Each catalogue recipe has a capability mapping, a named acceptance scenario, and an honest validated/blocked/not-tested status before any full-parity claim.
- **SC-007**: All applicable surfaces pass the same conversational setup and group scenarios; actual evidence identifies the exact surface and revision.

## Assumptions, Scope, and Delivery Boundary

- The product scope includes the complete catalogue, computer use, group collaboration, memory, routines, and learning. A bounded spike proves representative foundations, not catalogue-wide parity.
- The first spike uses one owner and two bots in a group. Multi-human and cross-owner positive collaboration are required production work; unauthorized cross-owner access must already be tested negatively in the spike.
- Conversational setup may reveal capabilities over time; there is no requirement to connect every recipe integration before starting.
- Provider-hosted credential consent is distinct from a Matrix configuration form. Credentials never belong in chat.
- Linux cloud computer use does not imply access to Mac-only applications or home hardware. Paired local executors and specialist integrations need separate qualification.
- This PR publishes the product specification, technical hypotheses, catalogue mapping, and spike protocol. It does not implement, run, deploy, or declare the spike successful.
- At the user's request the specification is published first. Undocumented SDK assumptions remain hypotheses until the subsequent spike; its results must update the design before implementation decisions are finalized.
- Deliverables: this spec PR; subsequent isolated spike PR and evidence report; implementation PRs after the decision gate; a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` once behavior is verified.

## Companion Documents

- [Technical design and security boundaries](technical-design.md)
- [Bounded spike protocol and decision gates](spike-plan.md)
- [Complete recipe capability map](recipe-coverage.md)
- [Specification quality checklist](checklists/requirements.md)
