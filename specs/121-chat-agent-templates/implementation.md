# Chat Agents and mentions — first implementation

Status: implementation authorized by Yuhan on 2026-09-10. This supersedes the earlier draft-only, multi-harness certification MVP for this delivery. The full design remains in PR #1550; this slice preserves the existing Chat UI and adds saved Agents and mentions with real Hermes execution.

## Product boundary

- Keep all existing Chat navigation, transcript, attachments, drafts, controls, Projects, Tasks, and streaming behavior.
- Add an Agents entry using existing Chat navigation styling. Its panel creates, inspects, edits, and archives reusable Hermes roles; creating an Agent does not start a Run.
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
3. **Existing Chat UI**: failing interaction tests; shared client/derivations, Agents panel, existing picker extension, attribution and state preservation. Use common components across Web Canvas, Web Desktop and Electron Desktop; adapt Native Mobile where its canonical Chat supports the capability.
4. **Validation and delivery**: required checks, React audit, current screenshots, real Hermes execution and no-reload streaming on an exact-head Preview VPS; separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/`. Keep flag off by default and wait for Yuhan's Human Review feedback before merging.

Use Graphite for stack operations. Each layer must remain deploy-safe with the switch off. Provider protocol doubles are not evidence of real Hermes execution.

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
Human Review evidence. UI and exact-head Preview verification remain pending.
