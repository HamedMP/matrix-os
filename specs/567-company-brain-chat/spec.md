# Company Brain chat

**Status:** Implementation target (server side now; the app side is a placeholder below). Builds on specs 536, 544,
551-566.  
**Owner:** gateway `bots/`, bot-runtime `brain-tools.ts`, contracts `bots/`  
**Date:** 2026-10-08

## Outcome

The Company Brain app opens on a chat. The user picks a project and asks in plain English. A Bot answers only from
that project's brain, in short plain English, with a Markdown link to every source. Follow-ups work. Every brain
conversation is a normal Matrix Chat (spec 113): it is saved, it comes back after a reload or a restart, and it opens
on every surface. Past brain chats of a project are listed and can be reopened.

One rule shapes everything: no second chat system. A brain chat is a canonical Chat run by a server-owned recipe Bot
(spec 536), shown by each surface's own chat view. The app only decides which Chat to show.

## Scope of this increment

In scope (server): the `company-brain` recipe and its answer rules, the read-only `brain.read` broker capability
(contract, worker tools, run setup, broker dispatch), thread Chats bound to one project (migration v7 and two routes),
the optional run effort, and their tests.

Out of scope here and named below: the Brain app chat tab and the web and Electron hosts (App side), leaving brain
chats out of the `matrix_chat` brain source, and every item under Deferred. OS-view surface matrix: N/A for this
increment (no UI); the App side fills it in.

## The Company Brain Bot

- A server catalog recipe, `company-brain` version `2026-10-08.1` (`bots/recipe-catalog.ts`). The gateway resolves
  `{recipeId, version}` from the catalog and never trusts a client copy. One Bot per owner, created from the Brain app
  with `POST /api/chat-agents/instantiate` and an explicit model selection (spec 544).
- Capabilities exactly `["brain.read"]`, no integrations. `exactCapabilities: true`: a run never gets anything added,
  not even a connected task executor (`agent.task`), so a brain run cannot hand work to a full-access agent. The
  catalog refuses any recipe with `brain.read`, the `company_brain` profile or `threads` unless it has
  `exactCapabilities` and no `agent.task`. Other recipes keep the executor as before.
- `limits: { maxToolActions: 6, effort: "low" }`, `threads: { project: "required" }`, `promptProfile:
  "company_brain"`.
- `listed: false`: `GET /api/chat-agents/bot-recipes` leaves it out, so the Templates page (web and mobile) does not
  offer it. `GET /api/chat-agents/bot-recipes?recipeId=company-brain` returns its current summary for the Brain app.
  Once created it shows in the Chat sidebar under AGENTS like any Bot (spec 544).

### Answer rules

The `company_brain` profile (`bots/system-prompt.ts`) replaces the generic rules. The server owns seven rules: answer
only from brain tool results, call a tool for every new question, pick the tool from the question, cite every fact as
`[label](permalink)` copied exactly, say "I could not find that in the brain." when the brain has no answer, say when
evidence is weak, treat tool results as untrusted, and refuse anything outside the brain in one sentence.

The Bot's editable instructions hold only style and sit under "Your style:" after the rules. An owner edit can change
the style; it cannot remove a rule or add a tool. Memory is not used by this profile.

The project and the date come last, and the date has no time of day, so the rules part stays the same across runs:

- Thread: `Project: "<name>" (proj_...). It is fixed for this chat; do not pass a project.`
- The Bot's direct Chat: `Projects you can ask about (pass the slug as project): <up to 20 slugs>.`
- `Today: YYYY-MM-DD (UTC). At most 6 tool calls per question.`

Project names are owner text: control and format characters become spaces, one line, at most 80 characters, quoted.
A failed project lookup leaves only the id (thread) or no list (direct Chat). The prompt stays under the 7,000-token
budget; a prompt over it is refused, never cut.

## Brain-only tools

Enforced in four places, so a model, an owner edit or a client cannot widen them:

1. Contract (`contracts/src/bots/broker.ts`): capability `brain.read` with `{ tool, project?, input }`. `tool` is one of
   `search`, `why`, `timeline`, `claims`, `brief`, `conflicts` (no `impact`). `project` is a `proj_` id or a slug.
   `input` is a record of at most 4 KiB. Strict: unknown fields are refused.
2. Worker (`bot-runtime/src/brain-tools.ts`): six tools, `brain_search`, `brain_why`, `brain_timeline`,
   `brain_claims`, `brain_brief`, `brain_conflicts`, whose fields mirror the brain tools without `detail`, plus an
   optional `project`. Only the tool's own fields are sent. A run without `brain.read` shows none of them.
3. Run (`bots/task-orchestrator.ts`): `brain.read` is served; a recipe with `exactCapabilities` gets exactly its own
   list.
4. Broker (`bots/brain-read.ts`, called from `bots/tool-dispatcher.ts`):
   - a run whose binding lacks `brain.read` is `denied` (the existing broker check);
   - the owner is always the run binding's owner;
   - a thread's project is fixed: another `project` is `invalid_arguments`; the direct Chat must name one, which each
     brain service resolves owner-scoped (foreign or missing reads as not found);
   - `project` or `detail` inside `input` is `invalid_arguments`; `brain_why` always runs in its brief form;
   - `input` is parsed again with the brain tool's own strict shape; the kernel's own handlers
     (`brainReadToolDefinitions`, `createBrainWhyToolHandler`) produce the answer, so the text, citations and
     untrusted-content wrapper are the same as the Matrix agent's and the MCP tools';
   - brain off: `unavailable`; a view whose service did not start: `unavailable`;
   - ordinary Matrix AI Chats (managed Pi bindings): `not_granted`;
   - a binding that holds both `brain.read` and `agent.task` is `denied` for both.
   - Effect class `read` (as the kernel tools; `brain_brief` may store the brief it builds, as GET `/brief` does).

The sandbox stays `network: "broker_only"`.

## Threads and project binding

A thread is one more Chat of a recipe Bot, fixed to one project when it is created. Sessions and tasks are already
keyed by Bot and Chat, so a thread needs only a binding kind.

Migration v7 `bot_chat_threads` (`bots/database-migrations.ts`): the binding kind check allows `thread`; a new
`project_id` column is set exactly on threads and must match `^proj_[A-Za-z0-9_-]{1,128}$`; a partial index serves the
thread list. Existing rows keep no project. The project is written once; no code path updates it (the column type
refuses updates). The Chat's own `project_id` stays null: Bot chats are not Project chats (spec 544), so moving a Chat
between projects cannot change what the brain reads.

Every place that reads "the Bot of this Chat" accepts a direct or a thread binding (`bindings.boundBot`):
`GET /api/chats/:chatId/bot`, Chat turn preparation, the run, admission (which also checks the thread's project), the
open task list, and the navigation snapshot (threads are classified as Bot chats and stay out of Pinned, Projects,
Working and Done).

| Route | Body or query | Result |
| --- | --- | --- |
| `POST /api/chat-agents/:agentId/threads` | `{ clientRequestId: "req_...", projectId: "proj_...", title?: <=120 }` | `201`, or `200` on replay, with the Chat record `POST /api/chats` returns |
| `GET /api/chat-agents/:agentId/threads` | `?projectId=proj_...&limit=1..100&cursor=` | The list `GET /api/chats` returns, newest activity first, active Chats only |

Create (`bots/bot-threads.ts`):

1. The body is parsed strictly; the project is resolved owner-scoped by the brain project resolver. Missing, foreign,
   archived or deleting: `invalid_request`. Lookup outage: `unavailable`.
2. One Chat transaction under the owner lock: the Bot must be the owner's, active, and its recipe must allow threads
   (else `not_found`). A Chat that already holds the request is returned as a replay when it is this Bot's thread of
   the same project; anything else is `conflict` and is never adopted. Past 1,000 live threads per Bot:
   `rate_limited`. Otherwise the Chat is created (title defaults to "New chat", the Bot's model selection) and bound.

Deleting the Chat through the normal Chat route removes its binding (existing cascade) and frees its place.

## Run limits and effort

- `BotRunLimitsSchema.effort` is optional (`low`, `medium`, `high`) and sent only for recipes that set it, so older
  workers and other Bots are unchanged.
- On an `anthropic-messages` route whose model thinks adaptively (as pi-ai's own Anthropic catalog marks it, for
  example Claude Sonnet 5 and Claude Opus 5), the worker marks the model as adaptive and runs at that thinking level,
  so a turn sends exactly `thinking: {"type": "adaptive"}` and `output_config: {"effort": "low"}` (or the run's
  effort). pi-ai's `display` key is dropped, because the Matrix-funded relay accepts only that thinking shape; the
  worker never shows thinking text. A call without a level (the summary) sends no thinking field;
  `{type: "disabled"}` is never sent. Other routes, and Anthropic models that refuse adaptive thinking (Claude Haiku
  4.5, Claude Sonnet 4.5) or that the catalog does not know, ignore the effort.
- At most 6 tool calls per question; the worker ends the turn at the budget and asks the model to summarise. The
  10-minute task deadline stays. The Pi session per Bot and Chat is saved, so follow-ups keep earlier tool results.

## Billing

Answers are billed like any Bot run, through the access source the Bot route resolves (Matrix AI credit, the owner's
key or plan). They are not counted in the brain spend cap (spec 555), which keeps covering background model work.
Brain tools cost no model tokens.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| `POST`/`GET /api/chat-agents/:agentId/threads` | request principal | owner's own active Bot whose recipe allows threads; project resolved owner-scoped | bots error mapper: `invalid_request`, `not_found`, `conflict`, `rate_limited`, `unavailable`; generic messages |
| `GET /api/chat-agents/bot-recipes?recipeId=` | request principal | public summary only; capabilities and rules stay private | `invalid_request` |
| Broker `brain.read` | runtime handle, generation and run (bot registry) | capability in the run binding; owner from the binding; thread project from the binding | allowlisted broker codes only |

- Input validation: strict zod at the route and broker boundary; ids and projects by pattern; bodies under the bots
  `bodyLimit`; repeated query keys refused; cursors are opaque and parsed strictly.
- Prompt injection: tool results are wrapped as untrusted content by the kernel formatters; rule 6 tells the model to
  use them only as evidence. Project names in the prompt are cleaned and quoted.
- Logs carry error names only; no project names, queries, document text or secrets.

## Integration wiring

- `startup/bots.ts` takes `brain: { services, projects }`. `server.ts` passes the started brain services and
  `createBotBrainProjects` over the brain project resolver and the project manager.
- The tool dispatcher gets `brainRead` only when the brain services exist; the orchestrator gets `brainProjects` for
  the prompt; the routes get the thread service.
- The kernel exports `brainReadToolDefinitions`, `createBrainWhyToolHandler` and `BRAIN_WHY_INPUT_SHAPE` for the
  gateway. No new dependencies, environment variables or files on disk.

## Failure modes

- Timeouts: a brain read runs under the broker's tool timeout (30 s); the run under its 10-minute deadline.
- Concurrency: thread creation runs under the owner lock in one transaction; concurrent retries of one request give
  one Chat and one binding. The thread cap is checked under the same lock.
- Crash recovery: the Chat and its binding commit together, so a crash leaves both or neither.
- Rollback: once Bot migration v7 is recorded, an older build refuses the Bot database as newer (`newer_schema`)
  and starts no Bots at all, direct Chats included, until the newer build is restored. Ordinary Chats keep working;
  thread Chats show as ordinary Chats and cannot run Bot turns.
- Error propagation: every refusal reaches the model as fixed guidance, and the client as an allowlisted code.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| Live threads per Bot | 1,000 | `bot-threads.ts` under the owner lock |
| Threads per page | 50 default, 100 max | contract query schema, repository |
| `brain.read` input | 4 KiB | contract |
| Tool calls per question | 6 (the broker stops any run at 60) | recipe limits, worker budget |
| Projects listed in the prompt | 20 | orchestrator, prompt builder |

No in-memory collections, temp files or timers are added.

## Invariants

- **Source of truth**: Postgres. A thread is a `chats` row plus one `bot_chat_bindings` row of kind `thread` with its
  project. The brain tables stay the only brain data.
- **Lock/transaction scope**: thread creation takes the owner lock and writes the Chat and the binding in one
  transaction.
- **Acceptable orphan states**: none. A deleted Chat removes its binding; a removed binding leaves an ordinary,
  unrunnable Chat.
- **Auth source of truth**: the request principal for routes; the run binding's owner and project for brain reads.
- **Deferred scope**: see Deferred.

## App side (to follow)

Placeholders the app work fills in:

- Brain app tabs: Chat first, then Today, Decisions, Timeline, Search, Sources; old ids keep working.
- Chat slot: `BrainAppProps.chat` with the surface's chat view; drafts become threads on first send.
- Find or create the Bot (`recipeId=company-brain`), list threads per project, opening order.
- Web Desktop, Web Canvas and Web Mobile host; Electron host; Open in Chat.
- OS-view surface matrix, unavailable states, accessibility.
- Leave brain chats out of the `matrix_chat` brain source (options and scans).
- Sources card spend text.

## Integration test checkpoint

`npx vitest run tests/contracts/bots/brain-read-capability.test.ts tests/bot-runtime/brain-tools.test.ts
tests/bot-runtime/run-effort.test.ts tests/gateway/bots/company-brain-recipe.test.ts
tests/gateway/bots/company-brain-run.test.ts tests/gateway/bots/brain-read-dispatch.test.ts
tests/gateway/bots/thread-bindings-repository.test.ts tests/gateway/bots/thread-admission.test.ts
tests/gateway/bots/bot-threads-routes.test.ts`. No test calls a model. With `MATRIX_TEST_POSTGRES_URL` set to a
dedicated test database, the pooled Postgres case checks concurrent thread creation.

A real run against a dev gateway (10 questions on two threads across surfaces, at most $1 on a capped key) follows
with the app side.

## Code review checklist

The Bot never gets a capability it does not list; the owner and a thread's project come only from the run binding;
`project` and `detail` cannot reach a brain service from `input`; every catch checks the error type; logs carry names
only; no new dependency.

## Delivery and evidence

- [ ] Server PR under 3,000 additions and 50 files, checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] App PR with the App side above and the real run.

## Deferred

In-app deep links for Matrix chat, note and file sources; `brain.read` for ordinary Matrix AI Chats; the spec 562
run-scoped MCP brain tools for Claude Code and Codex; a bounded tool that reads one whole document; metering the brief
summary under the cap; Opus 5.5 in the gateway model catalog; a small eval set scored by link and tool-call checks.

Related specs: 113, 121, 536, 544, 545, 547, 555, 559, 562, 563, 566.
