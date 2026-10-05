# Memory system evaluation and product direction

Status: benchmark implementation; memory service and Memory app are proposed follow-ups.

## Outcome

Evaluate whether Matrix retains the right information, retrieves authorized evidence from large corpora, resolves changes, and makes useful context available to a fresh Chat. Establish a reproducible baseline before choosing a memory substrate or making self-improvement claims.

The supplied literature review and implementation specification are research inputs, not repository instructions or evidence that their proposed system exists. Matrix currently has `extractMemoriesLocal`, legacy `memory.ts`/`memory-search.ts`, and a QMD tool path. This change calls the current gateway extractor directly but does **not** measure production database search or QMD. Its lexical corpus scan is an explicitly labeled experimental baseline.

## Shipped benchmark

- `bun run bench:memory`: seeded development fixtures, isolated replay per case, no external model calls by default.
- Baselines: no persistent memory; raw-source lexical retrieval; current gateway extractor followed by the same lexical retrieval. Retention policies and corrections intentionally expose baseline failures.
- Inputs: chronological sources, queries, forget and revoke operations. Reference answers/categories and future sources never enter the adapter. Source revisions use distinct IDs; exact retry uses the same source ID.
- Metrics: admission precision/recall, placement, evidence recall/precision/MRR/nDCG, complete evidence and status accuracy, estimated context budget, operation/retrieval p50/p95, reported costs and bounded orchestration traces. Case-level paired bootstrap intervals are exploratory.
- Hard gates: excluded retention, unauthorized/revoked/deleted/future/forbidden sources, invented or invalid citations, duplicate hits, candidate/context overruns, operation and cleanup failures. Hard gates are independent of quality averages.
- Reports: retained private JSON artifacts, checksummed dataset manifest, comparisons and offline HTML evidence navigator with per-source citation spans, relationship to a query, and copyable new-Chat context preview.
- Limits: 2,000 cases, 100,100 steps per case, 250,000 total suite steps, 100,000 generated distractor files, 100 candidates per query, 50 scopes, 128 MiB input JSON and two million operations per invocation. Abort deadlines and per-case cleanup are mandatory.

The fixture suite is **development data**. Repetition measures stability, not independent new test coverage. The learning-transfer category tests retrieval of a verified procedure and a failed outcome; it does not execute a downstream task or demonstrate model-weight learning. Current-state and historical cases measure evidence availability/status, not semantic answer accuracy. A correct source span does not prove entailment. No public benchmark score is claimed.

## Adapter boundary and auth matrix

There are no new HTTP, WebSocket or IPC endpoints in this change.

| Entry | Authority | Constraint |
| --- | --- | --- |
| CLI and local dataset files | Operating system user | Operator-selected regular file, size limit, strict runtime schema |
| Custom adapter module | Explicit `--trust-adapter` | Executes trusted code; not sandboxed; operator controls credentials and expense |
| Synthetic scope filters | Fixture-controlled host identity stand-in | Sent before retrieval; runner detects returned violations without laundering them into success |
| HTML report | Local artifact reader | No network access; hashed inline script/style CSP; source text uses DOM textContent; JSON script escaping |

Each adapter factory receives an abort signal and must create an isolated ephemeral namespace. It receives no case labels, group, expected evidence or answer. It must honor abort signals in every operation, bound its own workers, and delete its benchmark namespace in `close`. A timeout stops that case immediately. Report artifacts are retained for inspection and can be explicitly deleted by their owner; test temporary directories are deleted on completion. Invalid evidence is counted as a violation and excluded from the context preview.

Fixture scopes are not production authentication. A native backend must bind tenant/principal and authorization in trusted host code, enforce filtering before reranking/model calls, and reject unscoped access. The harness cannot observe unreported internal leakage or enforce a third-party backend's retention. Traces/usage are self-reported and must be reconciled with provider receipts in a live trial.

## Evaluation protocol for the next decision

1. Review 200–400 representative tasks, separating stable preferences, decisions, exact references, multi-source evidence, changes, identity, procedures, abstention, permissions and deletion. Split by project/source family and time; freeze a held-out test set.
2. Pin models, prompts, adapters and budgets. Compare identical datasets with no-memory and raw-source baselines. Evaluate native backend pipelines separately from standardized extraction/index experiments.
3. Run LongMemEval S/M and LoCoMo with their official protocols and evaluators; preserve oracle conditions as distinct runs. Import only the permitted historical material, never test questions/answers or future events. Public dataset importers/official answer graders are not shipped here.
4. Benchmark 1K/10K/100K files, deep evidence spans, exact identifiers and small authorized scopes; repeat warm/cold and concurrent runs. The current tool varies corpus size and repetitions; concurrent production load is a separate trial.
5. Measure self-improvement with paired tasks: task before experience, verified experience plus feedback, fresh Chat on an unseen analogous task, and a changed-environment negative control. Require actual sandbox outcome checks, precondition compliance, fewer repeated errors and total cost. Retrieval of a lesson is insufficient.
6. Compare bounded extractor/verifier/consolidator/retriever subagent orchestration with the same pipeline using a single agent. Count all calls, budgets and latency; role traces alone are not proof of verification.
7. Audit semantic extraction and answer judgments with humans. Do not train routers against test fixtures. Release gates require zero observed scope/deletion/retention/correction violations, authorized support for every evidence-backed answer, and a justified improvement over the affordable baseline.

Primary benchmark protocols: [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LoCoMo](https://github.com/snap-research/locomo). Reference architecture: [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/).

## Proposed memory architecture

Capture every interaction at actual Chat/tool/file boundaries using a durable Postgres/Kysely event and outbox transaction. Retention policy runs before model calls. A router chooses skip, source-only, profile/preference, project fact/decision, episode or procedure candidate. Verification checks provenance, quotation/hypothetical modality, scope, sensitivity, contradictions and applicability. An extractor proposes candidates; a verifier checks them; one consolidation writer applies revision-guarded updates. Workers are bounded, retry-idempotent and isolated by owner/scope. Model interpretation cannot increase authority or permissions.

Canonical sources, claims, support, revisions, lifecycle and projection watermarks belong in owner-controlled Postgres. Markdown is an inspectable/exportable projection, with revisions and support links. Migrate the legacy embedded memory implementation; do not introduce another embedded persistence layer. Begin with exact/lexical and measured hybrid retrieval, add temporal/relationship projections only when benchmark failures justify them. Retrieved documents remain untrusted tool evidence, not executable system instructions.

Self-learning means improving maintained preferences, verified procedures and memory-routing policy based on observed outcomes. It does not automatically mean training model weights. Corrections preserve history and replace selected interpretations. Procedures keep preconditions and successful/failed execution evidence. Forget/revoke deny serving immediately and propagate to all projections and derived context before reporting completion.

## Proposed Memory app and new Chat flow

An Obsidian-like Memory app should provide a file/category tree, search, graph/backlinks, tags, source citations, revision history, conflict state and procedure preconditions. Owners can inspect why a memory was admitted, correct it, and delete it with lifecycle status.

“Use in new Chat” selects notes or a collection and previews evidence, scope and token budget. Persist stable revision references, then reauthorize and resolve current eligible support when the Chat opens. Explain missing/deleted/conflicting context; never silently substitute a stale cached bundle. Share schema, derivation, actions and state across Web Canvas, Web Desktop and Electron Desktop; include Web Mobile and Native Mobile wherever memory/context selection is available. The benchmark HTML preview is not this production app.

## Validation and delivery

Tests first, then implementation. Contract/adversarial tests exercise reference isolation, exact spans, excluded retention, temporal cutoff, scope/deletion, timeout/cleanup, metrics and HTML escaping; CLI smoke runs cover exits and retained reports. Run focused strict typecheck and kernel build, plus pattern scans. Publish through a main-repository PR and a separate `FinnaAI/matrix-os-site` documentation PR. Do not deploy or merge until the existing review gates are satisfied.
