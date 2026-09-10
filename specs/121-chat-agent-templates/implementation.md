# Chat Agents and mentions — first implementation

Status: implementation authorized by Yuhan on 2026-09-10. This supersedes the earlier draft-only, multi-harness certification MVP for this delivery. The full design remains in PR #1550; this slice preserves the existing Chat UI and adds saved Agents and mentions with real Hermes execution.

## Product boundary

- Keep all existing Chat navigation, transcript, attachments, drafts, controls, Projects, Tasks, and streaming behavior.
- Add an Agents entry using existing Chat navigation styling. Its panel creates, inspects, edits, and archives reusable Hermes roles; creating an Agent does not start a Run.
- Agents occupies the main Chat content area instead of opening a modal. Keep the navigation rail available; on narrow Web screens, dismiss the rail after opening Agents. Back to Chat restores the same mounted conversation, draft, model and streamed updates. Selecting another Chat or a different runtime leaves Agent configuration. Recipe fields use the page's single scroll area.
- Extend the existing `@` picker with two labelled kinds: Agents execute the selected saved role; Chats supply context from another authorized conversation.
- One Agent and at most three referenced Chats per request. Selecting a suggestion does not send. Invocations are not sticky; the default Chat harness and model remain unchanged.
- `MATRIX_CHAT_AGENTS_ENABLED=1` is the server feature switch, default off. The server advertises availability; UI and all admission paths use that truth. With it off, ordinary Chat behavior remains available and new references fail closed.
- Hermes executes Agent runs. Model/account readiness comes from the existing V3-backed canonical catalog. Existing runtime tools and permissions apply; the UI describes the actual full-access mode before use and does not claim a restricted tool sandbox.
- No Kanban redesign, automatic scheduling, publishing, additional VM per Bot, or unrelated Chat visual changes in this slice.

## State and execution

Agent identity/configuration lives in owner-scoped Markdown under `agents/custom/chat-bots/`. A bounded registry supports stable IDs, revision checks, idempotent creation and archival. Canonical messages, runs, immutable execution/context snapshots and queues remain in owner-controlled Postgres through Kysely.

References carry typed stable IDs, never trusted labels or client-supplied transcript text. Admission resolves and validates references, selected Agent version, and Hermes readiness. It stores the exact bounded context before dispatch. A Run snapshot records the Agent identity/version and source Chat title, ID, message boundary and truncation. Source content is reference material, not higher-priority instructions. No nested references, tools, attachments or unrelated Chats are expanded automatically.

An Agent invocation runs Hermes in a fresh session, using the current request and bounded current-Chat history. It does not borrow another Bot's provider checkpoint or alter the parent Chat binding. Ordinary follow-ups after an invocation receive intervening canonical conversation context rather than resuming an unaware checkpoint. Results and activities use the existing canonical pipeline and carry Agent attribution; completion is not Task completion.

Queued work keeps references and resolved snapshots durable. Current-Chat history is refreshed under the claim transaction so the just-completed reply is included; referenced Chats and Agent definitions stay pinned. Queue text edits retain typed references; changing references requires cancelling and re-queuing. Dispatch rechecks feature availability, Agent archival and source access. Retry reuses the accepted snapshot and rechecks authority. New references cannot be steered into an active Run; the UI uses Queue next for them. Normal steering remains unchanged.

## Security and failure boundaries

| Route / operation | Authentication and authorization | Validation / limits |
| --- | --- | --- |
| GET `/api/chat-agents` | Existing request principal; personal owner only | Server flag; bounded Agent list; coarse readiness |
| GET `/api/chat-agents/recipe-catalog` | Existing request principal; personal owner only | Server flag; bounded bundled skill and integration service metadata; no credentials |
| POST `/api/chat-agents` | Same owner | Body limit; bounded strict schema; idempotency key |
| PATCH `/api/chat-agents/:agentId` | Same owner | Body limit; safe ID; revision compare; explicit fields |
| GET `/api/chat-mentions` | Same owner | Bounded query; current Chat exclusion; max results |
| GET `/api/chat-context/:chatId` | Same owner; private active Chat only | Safe ID; 40 messages / 8 KB text; no tools or attachments |
| Existing create/queue/retry turn APIs | Existing owner / collaboration guard | Flag, one Agent / three Chats, no forged snapshot, current catalog readiness |
| Dispatch / resumed queue | Server-owned snapshot | Recheck archival, reference access, flag and execution root |

- Do not expose raw provider, filesystem or database failures. Preserve drafts when admission fails.
- Agent paths derive from validated IDs and hashed owner scope; reject symlinks and oversized files. Serialize owner writes, use atomic file publication and revision checks, and clean temporary files after use and on startup.
- Related canonical DB writes and the snapshot commit in one transaction. Preserve active-Run exclusion, revision guards and outbox behavior. Dispatch occurs only after commit.
- File configuration can exist without any Runs; this is an intentional idle Agent. Archival blocks future execution while historical attribution remains readable.
- Reuse owned DB pools; no new pool or polling loop. Bound in-memory state and filesystem scans. Shutdown uses the existing orchestrator cancellation/drain path.

## Reviewable layers and tests

1. **Contracts and storage**: failing contract / filesystem tests; typed references, immutable snapshots, owner-scoped definitions; extract large admission functions with existing behavioral tests before adding execution logic.
2. **Execution and routes**: failing integration tests; persisted snapshots, Hermes routing, queue/retry/steering guards, server switch, authenticated CRUD/search and startup wiring.
3. **Existing Chat UI**: failing interaction tests; shared client/derivations, Agents panel, existing picker extension, attribution and state preservation. Use common components across Web Canvas, Web Desktop and Electron Desktop. Web Mobile consumes the shared Chat surface. Native Mobile does not yet expose saved Agents or these typed mentions; its existing Chat remains unchanged. Native controls and transport support require a separate parity follow-up before advertising this capability there.
4. **Validation and delivery**: required checks, React audit, current screenshots, real Hermes execution and no-reload streaming on an exact-head Preview VPS; separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/`. Keep flag off by default and wait for Yuhan's Human Review feedback before merging.

Use Graphite for stack operations. Each layer must remain deploy-safe with the switch off. Provider protocol doubles are not evidence of real Hermes execution.

### Recipe extension (2026-09-10)

New Web Chat titles compact to at most 80 characters including `...` while the
original request remains intact. Existing titles retain their canonical
200-character limit and remain valid as Agent context. Long titles and Agent
labels use bounded ellipsis in each applicable presentation, including existing
Electron Recents entries; full text remains available when inspecting the title.

A saved Agent may also declare a recipe: selected bundled skills, integration
dependencies with optional account labels, and the expected output. Existing
Agents without a recipe remain valid. Skills are resolved from the server's
fixed catalogue; clients cannot supply file paths or resolved instruction bodies.
Admission pins the skill content and hashes together with the dependency and
output configuration in the canonical Run snapshot. Edits affect future
admissions; queued work and retries retain their accepted recipe.

The shared Agents editor displays the catalogue and connection metadata through
the surface's authenticated transport. It preserves missing or inactive account
references and distinguishes a failed lookup from an empty connection list.
Multiple accounts require an explicit selection or an explicit choice to ask
when running. Saving an Agent does not run it or start an OAuth flow. Recipe
selections guide the workflow within the existing Hermes Full access mode.

Personal Daily Brief is the first editable recipe template. It uses the native
Matrix integrations tools, with the bundled command as a fallback, to read the
selected Gmail and Google Calendar accounts. It produces an English brief with
today's schedule, actionable follow-ups, priorities, source links or IDs,
retrieval time and data gaps. The requested timezone defines today. Reads are
bounded to the preceding 24 hours of inbox messages and today's calendar, at
most 30 messages and 50 events. It must report missing access instead of
connecting or syncing accounts, and it must not send mail, modify calendar
events, schedule future runs, or create extra files containing private data.

The first real-data validation requires the intended connected account to be
identified, visible evidence of source reads, a cited result that persists in
the Chat, and delivery without a reload. A connection preflight or a scripted
provider response establishes only that narrower layer of behavior. The public
site documentation PR is paused at Yuhan's instruction; it remains a delivery
follow-up before public rollout.

### Acceptance checklist

- [ ] Switch off preserves existing Chat and rejects new-reference execution.
- [ ] Agent creation/edit/archive is durable, owner-scoped, bounded and retry-safe.
- [ ] `@Agent` runs Hermes in the same Chat and attributes live/reloaded output.
- [ ] `@Chat` supplies bounded authorized context with provenance and no recursive expansion.
- [ ] Default binding, transcript, attachments, draft navigation and Tasks survive.
- [ ] Queue, retry, cancellation, revoked access and unavailable Hermes show truthful states.
- [ ] Web Canvas, Web Desktop and Electron Desktop pass interaction and visual checks.
- [ ] Native Mobile applicability and any platform limitation are documented and tested.
- [ ] Required typecheck, patterns, tests, React audit and production builds recorded.
- [ ] Exact-head real Hermes / streaming evidence and Human Review environment prepared.
- [ ] Public docs prepared with an accurate feature-switch boundary.

### Backend checkpoint (2026-09-10)

The first two layers implement file definitions, authenticated CRUD/search/preview,
server feature gating, runtime startup/shutdown wiring, canonical persistence,
one-request Hermes routing, default-binding preservation, retry/queue snapshots,
and steering guards. Gateway TypeScript passes; 80 focused Agent/contract/Hermes
adapter tests pass, and the 93 existing repository/orchestrator regressions passed
after the admission changes. Pattern scan: zero violations, five existing warning
categories. These are automated tests with protocol doubles, not live Hermes or
Human Review evidence.

### UI checkpoint (2026-09-10)

The shared Agents library supports create, edit and archive with recoverable
errors. Electron Desktop extends its existing composer; Web Canvas, Web Desktop
and Web Mobile use the existing Chat component with a scoped mention draft.
Agent selection does not send or change the default harness. Full access needs
explicit consent. Busy requests with mentions queue, and failed submissions keep
their draft and request identity. Historical receipts read persisted snapshots.
The original transcript, attachments, provider controls and Task surfaces remain.

The focused UI and existing composer/controller/projection regressions pass
(136 tests). Root, Web, Electron Desktop and shared UI TypeScript checks pass;
the pattern scan reports zero violations. Production Web and Electron Desktop
builds passed. React audits were run for all three React packages; existing
baseline findings remain. Full-suite results and final build verification will
be recorded in the delivery PR. Local browser checks use real gateway routes,
storage and SSE with a scripted adapter; they do not establish native Hermes
execution or full presentation parity. Exact-head Preview and Human Review
remain required before enabling or merging the feature.

Final local verification: the full suite completed with 14,498 passing tests,
34 skipped tests and 25 failures. Twenty-three failures reproduce on the
unchanged base `5a33ceb47` (billing, host scripts, workflow assertions, date-based
Todo checks and shell-install timeout tests). The two new native import failures
were fixed in the backend layer; both suites then passed all 34 tests. Browser
checks also caught a missing canonical request-ID prefix and user-message context
attribution through `turnId`; regression tests failed before each correction.
Ambiguous mentioned requests with attachments now retain the exact upload
references and request key on retry. The final focused UI run passed 76 tests;
Web TypeScript and production builds passed, and shared components are explicitly
included in both Tailwind scans. Browser validation confirms CRUD, mention
selection, explicit access consent, context preview and a response without reload
using the local scripted adapter. Native Hermes and full presentation validation
are still pending.
