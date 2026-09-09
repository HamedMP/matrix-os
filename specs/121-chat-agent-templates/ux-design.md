# Agents, Chat and Tasks: interaction design

Status: Proposed for Yuhan review, 2026-09-09. Research/design only. [OM-214](https://linear.app/matrix-os/issue/OM-214/research-grok-bot-workflows-and-specify-matrix-native-agent-templates).

## Recommendation

Make **Agents a reusable way to work inside Chat**. Keep everyday conversation lightweight. When work needs an outcome, owner or follow-up, track it as a **Task**. Give Projects a **Tasks** view with List as the default and Board as an alternative. Open every task into its working Chat and inspectable results.

A Bot homepage full of Kanban columns would make the user organize work before getting value. A single endless Chat per Bot would make separate deliverables hard to find and review. The proposed design offers a quick conversation entry and a durable work entry that share the same Chat runtime.

Use **Agent** in product copy and **Agents** for the library; “Bot” describes the researched category. Settings → **Agents & providers** continues to mean runtime/account setup. Inside Chat, **Agents** means reusable roles such as Meeting Brief or Sponsorship Assistant. If user testing confuses these destinations, rename the library **Your agents**, not the underlying harnesses. Do not introduce another top-level OS application.

## Relationship to the initial proposal

The September 6 [MVP spec](spec.md) proposes bundled templates and immutable Chat bindings, with no persistent custom Agent. This document answers the broader request for a complete creation/use/workspace/task design. It proposes the target experience; it does not silently expand that MVP's execution authority.

| Topic | Initial MVP | Full experience proposed here |
| --- | --- | --- |
| Discovery | Templates | Agents: My agents and Templates |
| Creation | Configure a template for one Chat | Save a reusable Agent; start separate work from it |
| Persistence | Definition snapshot bound to Chat | Versioned Agent definition plus per-work snapshots |
| Work tracking | Existing Chat/project organization | Canonical Task, multiple linked Chats, primary working Chat |
| Planning | No new task flow | Project Tasks: List and optional Board |
| Repetition | Use template again | Reuse manually; reviewed routines in a later phase |
| Authority | Proven restricted draft execution | Same default; explicit capabilities only when enforced |

The existing MVP spec/contract remains the executable Phase A boundary. Product implementation of Phases B/C requires revised contracts, migrations and Human Review. No reusable-Agent, Task or routine API is approved merely by this design.

## Evidence and adaptation

Research checked on September 9, 2026. These products inform the proposal; they do not prove Matrix supports the same capabilities.

| Primary source | Observation | Design inference for Matrix |
| --- | --- | --- |
| [xAI: Bots](https://docs.x.ai/grok-bot/bots) | Bots have durable roles and conversations; multiple Bots can share a computer. | Separate reusable role from work history. Make the selected Project/computer visible rather than implying one machine per Agent. |
| [Notion: Build your first Custom Agent](https://www.notion.com/help/guides/build-your-first-custom-agent) | Setup combines instructions, access, triggers and testing. | Start with job/output/context; reveal advanced execution and recurrence later. Include a test before unattended work. |
| [Linear: Agents in Linear](https://linear.app/docs/agents-in-linear) | Human accountability and delegated Agent work coexist on an issue. | Retain a human owner; show Agent separately. Do not replace ownership with an avatar of an AI. |
| [Linear: Agent interaction](https://linear.app/developers/agent-interaction) | Agent sessions have execution/attention states and link to their work context. | Task workflow, run status and attention are separate axes; navigation can expose them without creating another task store. |

Current-code review uses main `7551bfbf79fade6982a6fe6e6171af71d58c63a7`. WorkRail already organizes canonical Chats by project/pins/recency and derives attention from Chat state. Existing board cards have workflow statuses and a single `linkedSessionId`; that is not proof of canonical many-Chat-per-Task support. The task/thread distinction in `specs/105-coding-agent-shells/ARCHITECTURE.md` supports independent state. Provider V3 remains the source of harness/account/access-source/model readiness. Implementation must verify those seams on its own base.

## Object model users can understand

| Object | User question | Relationship and boundary |
| --- | --- | --- |
| Owner space | Whose work and data is this? | Personal or org ownership boundary; never implicitly mix data. |
| Workspace context | Where am I working? | Current owner, Project and computer context. Not a new entity or retired `__workspace__` route. |
| Project | What larger effort is this for? | Groups Chats, Tasks and explicitly selected context. Can be absent for personal work. |
| Agent | Who/what method should help? | Reusable job, instructions, output format and declared capabilities. Many independent Tasks/Chats. |
| Template | Where can I start? | Reusable starting definition; installing creates an owned copy without credentials or private history. |
| Task | What needs to be delivered? | Outcome, human owner, workflow, results, primary Chat and additional linked Chats. Agent is optional. |
| Chat | Where do we work through it? | Canonical transcript and execution surface. One Project and at most one primary Task association in the first Task release. |
| Run | What is happening now? | One execution attempt in a Chat. A retry is another attempt in the same Task, not another card. |
| Routine | When should this recur? | Later-phase trigger targeting an Agent version and scope; each occurrence has distinct work identity. |

An Agent is not a harness, model, provider account, background process, computer or task assignee replacing a human. Changing an Agent's display name does not rename past Tasks. Every Task keeps its execution snapshots and history when its Agent is archived.

## Information architecture and navigation

Keep the current WorkRail hierarchy and add only two utility destinations above Projects:

```text
Chat
  New chat
  Needs attention                 derived items, actionable count only
  Agents                          My agents | Templates
  Pinned                          existing Chats/Tasks by canonical identity
  Projects
    Launch campaign               project landing: Chats | Tasks | Context
  Recent                          canonical Chats, including Agent work
```

“New chat” is always immediately available. The composer has optional **Agent**, **Project/context**, and existing execution selection. Selecting an Agent does not create a Task or start a run. **Track as task** appears as an explicit choice during Agent launch and in an existing Chat's menu. For long deliverable-oriented templates it may be preselected with a visible Task title; ordinary chat defaults to untracked.

Project landing uses **Chats / Tasks / Context**, with the last subview remembered per Project. Tasks offers **List / Board** in the content toolbar. Agent profile uses **Overview / Work / Instructions**; later **Routines** appears only when supported. Work is a filtered projection of the same Tasks and Chats, not a separate “Bot workspace.”

Do not render a second nested global sidebar inside Chat. Web Canvas opens the same feature in a Canvas window; Web Desktop and Electron Desktop use shared content. All links route to the same canonical Chat/Task IDs.

## Screen inventory and layout

| Screen | Primary content and action | Secondary content |
| --- | --- | --- |
| New Chat | Composer, selected Agent/job, Start | Optional Project/context and Track as task |
| Agents library | Search, My agents/Templates, Create agent | Job, output and readiness on each card; no fake productivity score |
| Agent setup | Name, responsibility, expected output, context; Continue | Starting template and preserved unsaved state |
| Review setup | Effective access, selected account/sources, execution readiness; Create agent | Create and start test as an explicit alternative |
| Agent profile | Job, current version, Start work | Recent work, default context, Edit, Duplicate, Archive |
| Task work | Task title/status/owner above Chat; next relevant action | Result/context inspector, Agent/version, linked Chats |
| Project Tasks | Shared tasks in List or Board; New task | Agent/owner/status filters and empty state |
| Needs attention | Needs your input, Approval requested, Ready to review | Task/Chat link and precise pending action |
| Routine setup, later | Trigger/timezone, scope, limits, approval policy; Enable | Test result, next occurrence, pause and run history |

Desktop: preserve the approximately 240px WorkRail. Main content flexes; show a result inspector around 320–380px only when the remaining Chat stays usable. Under approximately 1100px total available application width, open results in a full content view instead of squeezing three panes. Below 640px, use stacked navigation and one content pane. Breakpoints follow container width in Canvas, not just browser width.

Use shared brand forest/paper surfaces, restrained coral/gold attention accents, existing typography and 8–12px control radii. One primary action per current decision. Status always has a text label. Agent initials/icon support recognition but do not create a separate visual identity for every card. Long task names wrap; timestamps and IDs remain secondary.

## Creation: three entrances, one builder

1. **From a template:** Open Templates → choose Sponsorship Reply Draft → inspect job/output/access → Use template. Prefill editable instructions; require selection of the user's own context and account.
2. **Describe a role:** Create agent → “What should it help with?” → generate a proposed name, instructions, input questions and output. The user reviews the proposal before saving. Generating configuration does not grant tools or schedule work.
3. **Save successful work:** Chat menu → Save as agent → extract reusable instructions and output shape. Preview exact retained material. Exclude transcript, people, addresses, files, secrets, approvals and connection IDs unless explicitly selected as owned context.

All three enter the same builder. First step contains name, responsibility, expected output and input requirements. Second step selects Project default and bounded context: pasted text/files/exact connected-account resources. Context chips disclose source and scope; Project selection alone grants no blanket file access. Third step reviews effective capabilities, source disclosure to inference, execution choice and limits.

Advanced disclosure contains harness/account/access-source/model, run budget/time limit and notification preferences. Keep a valid current execution choice. Explain incompatible or unavailable configurations and route to existing setup without losing the draft; no silent paid fallback. A “read only” promise appears only with proven restriction support from the backend.

**Create agent** saves without execution. **Create and test** saves then starts a clearly labeled test Chat using reviewed sample data; tests may incur inference usage and perform the selected reads, which the button area states. Test output can be inspected, refined and rerun. Failed execution preserves the saved Agent and setup; Create must not report failure if only the later test failed.

Back navigation preserves the draft. Closing with edits offers Keep draft or Discard. Reload restoration is owner-scoped. Validation appears inline and identifies a fix, including missing inputs, unavailable sources and unsupported execution modes.

## Use inside Chat

**Start new work.** Agent → Start work opens New Chat with the Agent chip selected. Ask for the inputs the job requires, not all configuration fields again. Show the selected Project and Task tracking choice. Review sources when needed, then Start creates one canonical Chat/run and optional Task atomically and idempotently. Recover the same objects after timeout/reload.

**Continue work.** Opening a Task resumes its primary Chat. The header shows human owner, Agent/version, workflow and run status separately. Follow-ups, Stop and Retry retain the Task ID. A source refresh previews the changed context; history is not silently rewritten.

**Track an existing Chat.** Track as task proposes a title and outcome, human owner and optional Project. Confirm links the existing Chat and creates a Task; it neither repeats the prompt nor copies history. Choosing an existing Task checks ownership/Project compatibility. When a Chat already belongs to another Task, offer an explicit reassociation or a new Chat with reviewed context; do not silently show one conversation as two independently editable workstreams.

**Change Agent.** For a new Chat, replace the selection freely. For existing work, default to New Chat for this task with the new Agent and a reviewed handoff summary. Keep earlier Chat/version readable and let the user choose the primary Chat. Do not retroactively change an active run's instructions or reuse incompatible harness resume state.

**Inspect outputs.** Result panel has Summary, Deliverable, Evidence and unresolved Questions. Each result links to the producing Chat/run and source freshness. Multiple attempts expose a version selector. Incomplete generation is labeled Partial. Chat text alone is not a verified result or proof of an external action.

**Finish work.** Request changes sends feedback in the same Task and starts work only through explicit canonical admission. Accept result records acceptance for the selected result version. Mark done is a separate workflow mutation. A draft accepted by its owner is still a draft; sending/publishing is a distinct scoped action.

## Task workflow, execution and attention

Target workflow: **To do → In progress → Review → Done**, plus Archive outside the active board. Blocked is a reason/attention marker that preserves the workflow stage. The human owner can move work backward. Review means an outcome is awaiting human evaluation, not that a tool is awaiting permission.

| Event | Task workflow | Run state | User-facing action |
| --- | --- | --- | --- |
| Save planned task | To do | No run | Start work |
| Explicit Start work | In progress | Queued/running | Open Chat; Stop when running |
| Agent asks a question | Unchanged | Awaiting input | Answer in Task Chat |
| External action requested, later | Unchanged | Awaiting approval | Review exact action scope |
| Run finishes with usable output | Unchanged until a workflow event | Completed | Review result; Submit for review |
| Submit for review | Review | Unchanged | Accept result or Request changes |
| Accept result | Review; acceptance recorded | Unchanged | Mark done |
| Mark done | Done | No running attempt allowed without resolving it | Reopen |
| Error or user Stop | Unchanged | Failed/canceled | Retry or revise instructions |
| Move board card | Explicit selected stage only | Unchanged | No implicit execution or approval |

A run-completion event must not automatically move a card to Done. A later explicit project policy may submit verified outputs for review, but the rule must be visible and auditable. If someone tries to mark a running Task Done, offer Cancel run and mark done as a combined confirmed operation or keep it active; do not hide a live process behind Done.

Current board statuses are `todo/running/waiting/blocked/complete/archived`. For the first Task integration, preserve those existing meanings or ship an explicit versioned migration. In particular, `waiting` cannot be relabeled Review and `blocked` cannot be discarded automatically. Migration must preserve legacy state, blocked reason and audit history; classify ambiguous records with a visible legacy marker and an explicit user action. The target mockup illustrates the new workflow, not a claim that the old schema already supports it.

## Why List first, when Board helps

List gives titles, next action and results more space and scales to personal work or a narrow window. Board helps compare concurrent deliverables across a Project and spot review bottlenecks. It becomes useful when the user actively manages work across stages; it is not necessary to create/use an Agent.

Both views use identical Task IDs, filters, counts and ordering rules. Remember the selected view per Project. A card shows title, Agent, human owner, workflow, run/attention label and latest result indicator. Click opens Task work. Status menu provides the keyboard/touch equivalent to drag. Dragging is optional, never the only way to move work.

Empty Project: “Track work you want to come back to” with Create task and Start with agent. Empty column: simple label, not another setup prompt. Empty filter: Clear filters. Done is collapsed or filtered by default once history grows; Archive remains recoverable. Do not duplicate cards per run, subagent, Chat message or routine retry.

## Attention, permissions and trust

Needs attention is a projection of canonical pending input, action approvals and review-ready results. The same pending action opened from Chat, a Task, WorkRail or a notification has one ID and resolution. Separate Approval requested from Ready to review: approving a tool action is not accepting a deliverable. Do not invent another approvals ledger.

An action review shows what will happen, affected resources, destination/account, exact payload preview, scope/expiry and Allow once / Deny. Changed payloads invalidate prior approval; resumed runs recheck authorization. Bulk approval and approval via board drag are excluded. External writes and live tools stay unavailable until capability enforcement is demonstrated across the complete harness path.

Owner defaults to the initiating human; Agent is shown as Doing the work. Later org roles must authorize both the Task and its linked resources. A shared Agent definition grants no data access. Changing owner space resets selected accounts and context before another run. If a user loses permission, preserve only the history they remain entitled to view and remove actionable controls with safe copy.

## Agent lifecycle and recurring work

Edits create a new Agent definition version. Existing work keeps its pinned instructions/sources. New work uses the latest eligible version; adopting changes in existing work requires a diff and a new reviewed run boundary. Archive stops new starts and asks how to handle active runs and routines. It does not delete historical results. Permanent deletion is separate and follows owner export/deletion policy.

Duplicate copies reusable configuration, not credentials, grants, history or private samples. Agent instructions remain inspectable/exportable files in the future Custom agents namespace; operational links/results/triggers live in owner Postgres. Reconcile file changes and DB metadata explicitly in the later technical design; do not create two editable instruction stores.

Routines are a later phase inside Agent profile, not a prerequisite to first use. Setup requires trigger/timezone, selected Project/context, output destination, limits and policy; show next occurrence and test result before Enable. Pause blocks future occurrences without pretending an active run stopped. An occurrence key deduplicates retries and creates one Task/work instance; distinct scheduled deliverables create distinct Tasks. If a source is missing or policy changed, pause and request repair instead of repeatedly creating failing cards. Avoid catch-up floods after downtime; require a documented skip/coalesce policy.

Notifications default to meaningful input/approval/review/failure events, deep-link to the canonical work, and deduplicate across surfaces. Routine success can be a digest or quiet mode; do not notify for every token or every unchanged poll.

Delegation remains inside the owning Task unless a human explicitly promotes a sub-result to a child Task. Show delegated activity in Chat when helpful. Do not populate the board with internal agent processes. Scheduling, delegated execution and shared-agent publishing require separate capability/RBAC designs before shipping.

## Responsive behavior, accessibility and recovery

| Situation | Required experience |
| --- | --- |
| Web Canvas | Same library/builder/task/result actions in a resizable Canvas window; container-responsive layout |
| Web Desktop | Shared desktop feature; persisted local view preferences |
| Electron Desktop | Ongoing visual/interaction reference; same business state and capabilities |
| Web Mobile / Native Mobile, when exposed | Same creation/use/status/approval semantics; list default, result screen with Back to chat, status menu instead of required drag |
| Loading | Bounded skeletons; preserve last known content during refresh; never flash an empty library |
| Offline / disconnect | Show stale state and reconnect; preserve draft; do not fabricate a running start or optimistic approval |
| Start timeout | Recover by request ID; offer Open existing work, not a blind second start |
| No compatible harness | Explain unavailable mode and open existing setup, returning to draft |
| Source disconnected | Identify selected source safely; Reconnect or Remove source and review again |
| Save conflict | Preserve local edits, show changed version and explicit comparison/retry |
| Permission denied | Safe message, no leaked resource/account/provider internals |
| No result / partial / failed | Distinct labels, retained work history and relevant next action |

Keyboard users can reach navigation, Agent choices, forms, task status and results with visible focus. Dialogs restore focus to their trigger; route changes focus the new heading. Screen readers receive concise admission/attention changes, not streamed-token announcements. Touch targets are at least approximately 44px. Color is never the sole status signal; reduced-motion users get no unnecessary transitions. Long names and translated labels must fit at 320px without horizontal page overflow.

## Delivery phases and review criteria

**A — Template work in Chat.** Deliver the existing restricted MVP first if accepted: two templates, setup/source preview, canonical Chat, correct execution/source disclosure and result readback. Use Templates navigation until saved Agents exist. No placeholder Create agent button.

**B — Reusable Agents and durable Tasks.** Add owned Agent creation/versioning, Track as task, canonical Task/Chat associations, primary Chat, result acceptance, Project List/Board and derived attention. Requires migration of legacy board links/statuses and shared capability/state contracts. This is the complete manual-work loop illustrated by the design, with no implicit external writes.

**C — Routines and controlled actions.** Add reviewed triggers, occurrence deduplication, enforced scoped tool capabilities, real action approval, budget/limits and reliable recovery. Do not market Phase A as this phase. Shared Agent distribution/org policy can follow separate authorization work.

Each implementation phase follows TDD, updates the contract/auth matrix before new endpoints, proves runtime wiring and owner isolation, and prepares exact-head Human Review. Product delivery includes a separate public-documentation PR in `FinnaAI/matrix-os-site`; this research change does not modify that repository.

Usability validation proposal: test with five representative users, observe rather than explain the model, and treat the following as acceptance targets rather than measured outcomes:

1. Start a Meeting Brief from a template, selecting only intended sources; at least four of five can explain what data it accesses and whether it can send anything.
2. Create a reusable Agent and start two independent jobs; users can find both outputs without treating one Chat as a global memory bucket.
3. Track existing work as a Task without losing messages or producing a duplicate run.
4. Switch List/Board, move a Task and explain that this did not run an Agent or approve an action.
5. Respond to missing input, inspect a result, request changes, accept the new version and mark Done; all entry points agree.
6. Retry an interrupted start and reconnect a missing source without creating duplicate Tasks or losing setup.
7. Complete core flows using only keyboard and at 390px width; confirm 320px fit and readable dark appearance.

Observe time to first useful result, setup abandonment, task reopen/rework, duplicate-start rate and successful attention resolution. Define analytics using IDs/stages only; do not collect prompts, files, source bodies or credentials. Establish baselines before setting numeric production targets.

Design decisions proposed for review: Agents inside Chat; optional Task creation; human owner plus Agent; Project List default with optional Board; explicit result acceptance separate from external-action approval; advanced routines after the manual loop. The immediate design review should exercise creation → work → result → Task views before approving implementation scope.
