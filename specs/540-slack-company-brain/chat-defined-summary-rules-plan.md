# Chat-defined Slack summary rules implementation plan

> For agentic workers: use the existing Trellis implement/check workflow. Implement directly in the persistent Slack worktree; the main session owns commits and rollout decisions.

**Goal:** A user configures durable Slack summary behavior by talking to their bot in a private Matrix Chat. Ordinary messages and owner mentions are selectable triggers. Reports remain private Matrix text.

**Architecture:** The platform authenticates enrolled Slack source provenance; owner Postgres stores executable, revisioned user rules. Native Chat tools manage those rules. The existing signed intake, durable summary jobs, canonical queue and zero-tool/one-inference executor perform the work. No second router or timer scheduler.

**Tech stack:** Existing TypeScript/Zod4, Hono, Kysely/Postgres, Vitest and native bot tools. No dependencies or alternative databases.

**Spec:** Existing 540 Slack spec, active Trellis prd/design/implement and research/chat-defined-slack-summary-rules-2026-11-20.md. The user approved implementation after the stated Chat-create/persist/execute/lifecycle plan.

## Global constraints

- Modify only the isolated matrix-os-slack-integration worktree; preserve unrelated primary work.
- Source access remains the existing explicitly enrolled channel/thread; no chat instruction can grant another source, org, user or runtime.
- Rules, receipts, job insertion and lifecycle fences use owner Postgres and transactions/CAS. No prompt-only or generic memory-only execution policy.
- Manual rule tools are owner/private-Chat/interactive only; automatic summaries retain no tools or generic memory, one inference, ephemeral context, private output and existing aggregate25/day,100pending/concurrency1 bounds.
- No runtime rule activation, Slack calls/messages, paid model calls, environment changes, merge, push or deployment during local implementation. Pushing this branch auto-builds/deploys Preview; leave commits local for main coordination.
- Agent prompts, responses, demo artifacts, PR content and documentation are English. Bilingual synthetic unit inputs may verify Chinese owner instructions with English output. Main user conversation remains Chinese.
- Missing critical cadence/focus fields are clarified in Chat; no silent global every-message activation. Keep current source grants and native manual-read compatibility.

## Bounded first slice decisions

- Deterministic source triggers: new_message and owner_mention. Natural-language report focus and requested output language are bounded fields; do not add an always-running semantic evaluator.
- Support explicit immediate delivery and a bounded per-thread coalescing window. Cadence must be supplied/acknowledged; preserve all contributing source refs and a stable persisted batch identity. Calendar digests/cron and cross-thread semantic grouping remain later work.
- Ordinary human messages may include the owner; owner_mention remains a genuine mention by another human. App/bot/subtype/external sources cannot create a self-trigger loop. Reads remain within the enrolled source.
- Prefer direct durable creation/update from a clear explicit owner standing request, with server-derived canonical owner-message provenance. Reuse existing imported-content/confirmation barriers when needed; do not invent blanket external approval or allow an agent claim/Slack body to authorize standing work. One-shot summary instructions must not silently create standing rules.
- Use list/get/create/update/pause/resume/delete with strict schemas, source-bound identity and CAS revisions. Return a persisted receipt describing source, trigger, cadence, focus, language, state, revision and private destination. Acknowledgement must reflect committed state.
- Keep a small rule cap and prevent duplicate overlapping delivery for the same bot/source policy. The implementer may use one current policy per bot/enrollment with historical revisions as the smallest coherent first slice; make this limit explicit in receipts/docs rather than silently emitting multiple summaries.
- Updates invalidate old-revision pending work. Pause/delete revoke late read/inference/publication; resume advances enabledAfter with no historical catch-up. Deleted means inactive audited tombstone; past owner summaries remain.
- Do not auto-import the environment rule as user-created. Once an explicit owner policy controls an enrollment, legacy fallback must not reactivate a paused/deleted policy or double-dispatch. Preserve strict legacy compatibility for unenrolled migrations.
- Native rule authority is a process-private authenticated owner HTTP input stamp, persisted atomically on the original canonical Turn or queued input. JWT/platform-verified personal-owner requests qualify; internal Slack submissions, configured-container/dev-default principals, imported content and automatic runs do not. Retries inherit the original Turn rather than manufacturing authority. Mutation idempotency uses the original owner message, so replay after a later pause/delete cannot reactivate a rule.
- Preserve rolling compatibility with the installed strict owner bridge: keep the old JSON body and its signature unchanged. Carry the bounded enrolled-source extension in a separately runtime-signed header binding exact body, path and timestamp. New owners reject inline wire `source` and malformed/tampered extension pairs; old owners ignore the extension and retain existing passive/legacy behavior. The platform source proof still binds the current enrollment incarnation and content digest.

## Review focus

1. Rule-looking commands embedded in Slack/tool results must never mutate owner policy; verify the canonical owner source and execution class.
2. Ordinary non-mentioned events must actually reach the same restricted executor under saved policy; a repository-only CRUD test is not acceptance.
3. Version/lifecycle changes after queueing or while waiting must invalidate old authority before read, paid inference and private output.
4. Coalescing and duplicate delivery must survive restart/concurrency without dropping contributing refs or admitting duplicate logical work.
5. Source-only attestations must not widen enrollment, trust a caller-supplied mention flag, bypass private Chat sharing fences, or break native reads and legacy signed proofs.

## Task 1: Typed owner rules and native Chat management

Files: add focused contracts under packages/contracts/src/bots/, owner repository/service and versioned migration under packages/gateway/src/bots/ or slack/. Wire packages/bot-runtime/src/tools.ts, gateway bot tool dispatcher/task orchestrator/startup.

Large-file boundary: canonical Chat repository and queue files retain only original-column persistence and calls to focused authority helpers inside their existing transactions. New intent, policy, proof and lifecycle logic belongs in `owner-http-input.ts` and focused Slack rule modules. Subsequent extraction should move original/queued input admission and lifecycle authorization together behind the same transaction interface; it must not introduce a second queue or change lock order. Keep this slice's edits at the existing commit/claim/finalization seams.

- [x] Write failing tests for strict operation schemas, owner-derived identity/provenance, receipt truthfulness, persistence/restart, CAS conflicts, pause/resume/delete and one-shot/imported-source denial.
- [x] Implement minimal rule storage/service and owner interactive-only native capability. Reuse existing Chat authority/lifecycle/provenance mechanisms; do not widen timer-routine funding.
- [x] Run those tests against real PostgreSQL and verify no implicit active rule exists.

## Task 2: Source-only proof and policy-driven event jobs

Files: contracts/src/slack-bridge.ts; platform Slack source/context/proof modules; gateway owner context/job modules. Extract focused helpers rather than growing large entrypoints.

- [x] Write failing full-boundary tests for a signed ordinary human event with active new_message rule and a signed real owner mention with owner_mention rule. No rule/nonmatch must remain passive.
- [x] Decouple source proof from env predicate: bind enrollment/install/link/runtime/source tuple/content digest and trusted mention classification. Keep existing transport and strict versioned legacy compatibility.
- [x] Evaluate owner rules atomically with source storage; bind durable jobs to rule/revision and source proofs. Add bounded persisted per-thread window/coalescing and stable event dedup using existing job dispatch.
- [x] Carry exact focus/language into restricted summary input; revalidate live rules at claim/read/admit/inference/publication. Invalidate old revisions and late work on lifecycle changes.
- [x] Run real-Postgres signed ingress -> canonical queue -> actual worker/inference broker with synthetic providers. Assert one private summary, no tools, no Slack output or ordinary-session pollution, and correct limits.

## Task 3: Compatibility, independent review and documentation

- [x] Run native manual-read, existing Slack summary/lifecycle and relevant routine/memory authority regressions; canonical native typecheck and release TS5 targets. Fixtures must actually use the requested PostgreSQL connection.
- [x] Independent Trellis check must fix verified issues and repeat affected tests. Document remaining live/UI/release gates separately.
- [x] Update executable Slack specs and public-safe documentation. Include a separate FinnaAI/matrix-os-site documentation PR deliverable; do not publish claims of live availability before matching runtime acceptance.
- [x] Main reviews exact diff, commits locally with a Conventional Commit and updates existing Draft PR evidence/status without triggering auto-preview pushes. Keep broader task in_progress until separate rollout/real Slack gates are closed.

Local implementation and independent review are qualified in [chat-defined-summary-rules-validation.md](chat-defined-summary-rules-validation.md). The broader task remains in progress: interactive-agent/UI acceptance, exact-version Preview rollout, remote CI/review and the separate site-repository documentation PR are still pending.
