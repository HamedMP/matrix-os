# Company Brain claims

**Status:** Implementation target (claims layer of the brain stack; builds on specs 551, 552, 553)  
**Owner:** gateway `brain` domain (`brain/claims/`, `brain/api/`)  
**Date:** 2026-10-01

## Outcome

Matrix stores the claims a project's synced pull requests, commits and specs make (invariants, decisions,
commitments, risks), each with a verbatim quote and its span in the stored body. The owner runs bounded extractions
(`POST /api/brain/projects/:projectId/extract`) and lists claims, optionally for one file or folder (`GET .../claims`).
This increment ships the deterministic rules extractor (now `rules/v2`, see Rules versions) and the model seam with its
verification; no model is wired.

## Scope of this increment

In scope: `brain/claims/` (contract, tables, store, reads, rules, verification, job), five `BrainRepository` methods,
claim cleanup inside the existing tombstone, source-delete and erase transactions, `brain/ref-match-types.ts` (types
moved out of `types.ts`, importers unchanged), `api/claims-types.ts`, `api/claims-service.ts`, two routes and tests.
Out of scope (no stubs): see Deferred. OS-view surface matrix: N/A (no UI; a JSON API, nothing to keep in parity).

## Claims model

- Tables, created at the end of the existing bootstrap transaction: `brain_claims` (PK `(owner_id, scope_id, claim_id,
  extractor)`), `brain_extraction_state` (per document and extractor: incarnation, revision, status, attempts,
  `error_code`) and `brain_extraction_runs` (status, counters, usage, `next_action`). Indexes: `brain_claims_document`
  (per-document replace and read join), the partial unique `brain_extraction_runs_running` (at most one running run per
  scope, the cross-process backstop) and `brain_extraction_runs_started` (newest runs first, retention).
- A claim: document id, incarnation, `revision` (read from), `kind`, `label` (or null), `statement`, `quote`, spans,
  `fields` (strict `{ assignee?, due?, severity? }`), `extractor` (`rules/v<N>` or `model:<model-id>/<prompt-version>`),
  `confidence`, `created_at`. Every limit is a SQL CHECK and a strict zod schema.
- Claim id: sha256 of `["brain_claim_v1", documentId, kind, label, statement]`, label and statement normalized (NFC,
  whitespace runs to one space, trimmed, lowercased); never spans or the extractor, so moved text keeps its id,
  rules and model claims for the same text coexist, one row per extractor, and a claim a new rules version reads the
  same way keeps its id. `brain_claim_v1` versions the recipe, not the extractor; rules versions leave it unchanged.
- Offsets: UTF-16 code units into the stored body; `body.slice(spanStart, spanEnd) === quote` is rechecked on every
  write. Extractors read `claimSourceText(document)`, a body prefix that stops before spec 552's git footer.
- Replace: one (document, extractor) set at a time under the scope lock; dropped ids are deleted, the rest upserted
  keeping `created_at`. Failed and skipped outcomes write state only. Stale, at read time: the claim's `(incarnation,
  revision)` is not the live document's. Pending: no state row for the extractor, one for another `(incarnation,
  revision)`, or `failed` below `maxAttempts` (attempts restart per revision); oldest first. State of another rules
  version never counts as done for the current one.

## Rules extractor

Grounded in 1,993 first-parent PR and commit bodies of this repository (582 yield 2,925 invariants, 295 commitments,
8 decisions, 5 risks; at most 23 per body, cap 50) and the 135 specs on `origin/main` (69 yield 394 invariants, 68
decisions, 58 commitments, 11 risks). `claims/rules.ts` is pure and never throws; it skips code fences (closed, as in
`why.ts`, by a run of the fence character at least as long with only spaces or tabs after it), HTML comments (from
`<!--` anywhere on a line to `-->`; one ends the open item, so no quote reaches into it), tables, images and trailers,
and `---` ends every section (squash bodies). Each quote gives at most one claim.

- Sections: ATX and bare headings (`Invariants`, `Deferred scope:`), first match: `open decision(s)/question(s)`
  (undecided: none); `invariant` or a canonical label (not a bare `Auth`/`Authentication`/`Authorization` feature
  heading); in-scope words (`Goals`, `In scope`, also in `Goals / Non-Goals`) open none; `deferr`, `non-goal`,
  `out of scope`, `follow-up stack` (deferred); other `follow-up(s)` (ignored: done review work); `decision(s)`;
  `risk(s)`; `Scope...` (none); `next step(s)`. A level-1 heading is the title and opens nothing. A sub-heading of a
  claim section keeps its kind unless it names its own; under deferred its items stay `Deferred scope`, else the
  sub-heading is their label. In-scope and open-question sub-headings open nothing, even under a Decisions or
  Invariants heading, and a bare `**Open questions:**` line ends the section instead of labelling it. Items labelled
  `Open question(s)` or `Open decision(s)`, or nested under such a label, are dropped unless they carry a kind prefix.
- Design notes: a sub-heading of a decisions section that does not name a decision itself (`### Canvas Title Bars`
  under `## Key Design Decisions`) often describes the design instead of choosing it. Its items are decisions only
  when they carry their own label or a `Decision:` prefix, or state a choice: chose, decided, instead of, rather than,
  prefer, must, never, will, shall, a leading `Use`, `Keep` or `Do not`, or `use` after we, to or a modal. Other
  items are dropped. Items placed directly under a Decisions heading are kept as before. On the 135 specs this drops
  28 of 96 decisions (specs 033, 057 and 084's `Stripe Surface` and `Plan Projection`); PR bodies keep all 8.
- Items: bullets (checkboxes skipped) with wrapped lines; nested bullets inherit a label-only parent; paragraphs count
  when labelled or a section's only content; `none.`, `n/a` and process lines (Greptile, merge gates) are skipped.
  Labels: bold `**X:**` / `**X**:`, a plain canonical `X:` (Source of truth, Lock/transaction scope, Acceptable orphan
  states, Auth source of truth, Deferred scope, Resource bounds, plus aliases), else inherited. `Decision:`, `Risk:`,
  `Follow-up:` / `Next step(s):` / `TODO:` prefixes give their kinds. Confidence is `medium` for Invariants items
  without a canonical label and for Deferred-scope commitments, else `high`. Quote: the item text with its label (at
  most 2,000 units, surrogate pairs whole); statement: the text after the label, collapsed, at most 1,000 units.
- Deferred scope, decided from data: every item is an `invariant` labelled `Deferred scope`, or, when it names
  future work (later, next, follow-up, `#N`, `PR N`, `layer N`, will land, a separate follow-up PR), a `commitment`
  labelled `Deferred scope` instead, never both. Of 500 surveyed entries 44% carry such a marker, 34% are bare
  exclusion lists and 21% pure non-goals; AGENTS.md defines the label as what is explicitly not in scope. Storing
  one kind per quote removed 352 duplicate quotes (295 in PR bodies, 57 in specs).

## Rules versions

- `BRAIN_RULES_VERSION` (`claims/types.ts`) names the extractor `BRAIN_RULES_EXTRACTOR_ID` = `rules/v<N>`. It is raised
  whenever `rules.ts` decides differently, so documents already done under an older version are read again. `rules/v2`
  is the first raise: design-note items are decisions only when they choose (above), and open questions and open
  decisions are never claims.
- Pending: a document is pending for the current rules version whatever its state under another rules version.
- Replace across versions: any applied rules outcome (done, failed or skipped) for the live `(incarnation,
  revision)` first removes the document's claims and state of every other rules version, in the same transaction as
  its own claims and state. The deleted claims count in `removed` and the run's `claimsRemoved`, so the change event
  fires and search and graph re-index. One document never holds two rules generations, and the scope cap never needs
  room for both. An outcome for a revision that is no longer live removes nothing.
- Reads: until the current version writes a document, its older rules claims stay readable, flagged stale as usual.
  `GET .../claims` also hides another rules version's claims once the current version has state for the document,
  and a document that still has another rules version's state is pending, so rows an older gateway writes late are
  hidden at once and cleared by the next rules run.
- Model claims and state are never touched by a rules write, and a model write never touches rules rows.

## Model seam and verification

- `BrainClaimModel.extract({ title, body, kinds, maxClaims }, signal)` resolves `{ claims: [{ kind, label?, statement,
  quote, fields? }], usage: { inputTokens, outputTokens, costMicroUsd } }`. No adapter exists yet: the job answers
  `model_not_configured` without one, the route 409 `extractor_not_configured`.
- `verifyModelClaims` trusts nothing: a non-array or more than 200 candidates is `model_output_invalid`; each must pass
  the strict candidate schema with a requested kind (else `claimsRejected`). The quote is located with whitespace runs
  matched as one, in rendered text only (HTML comments and code fences, whichever opens first, are masked, so a quote
  in or across one is not found), at the first occurrence that neither starts nor ends inside a word; the exact
  original substring and span are stored, `medium` when verbatim, else `low`; not found is `quotesRejected`. The
  statement must be whole words of the stored quote (normalized; else `claimsRejected`) and a label that is not is
  dropped, so `safe` is never read out of `unsafe`. Search work per document is capped (text units x quote units per
  search, 2^32, about 0.3 s worst case on a 64 KiB body); later candidates are `claimsRejected`. Usage outside its
  schema charges that call's worst case to the run, as a timeout does, and stops the run (`model_usage_invalid`).
- `finalizeBrainClaims` (both extractors) drops drafts whose span does not slice to the quote or that break a store
  bound (lone surrogates included), computes ids, keeps one claim per quote span, orders by span then id, drops
  duplicate ids and keeps at most 50. A quote given under several kinds keeps one by a fixed precedence
  (`BRAIN_CLAIM_KIND_PRECEDENCE`): commitment, then decision, then risk, then invariant, then the smaller id. So
  deferred work that names later work is a commitment, not an invariant, and a chosen design a decision, not an
  invariant. Each dropped claim with another id counts as `claimsRejected`; a repeat of the same id does not.

## Extraction job

`runBrainExtraction({ repository, scope, extractor, model?, limits, signal, now })` never rejects. It validates the
options, takes the in-process guard (at most 16 scope keys, cleared in `finally`), opens a run (a running row younger
than the 5-minute lease is `extraction_in_progress`, an older one becomes `interrupted`) and gives each pending
document its own transaction: re-read, extract, `applyDocumentExtraction` fenced by the run id. A document revised
meanwhile stays pending (`run_again`); an extractor or model throw (synchronous or not) fails that document; claims the
store or Postgres refuses (`invalid`, SQLSTATE class 22 or 23) are re-applied as `claim_invalid`. It stops early,
without failing, on abort or a time, body-byte, token or cost budget. The run closes `failed` on a run-level code,
`partial` with failed documents, else `succeeded`; `nextAction` is the code's action, `run_again` when work is left,
`retry_later` after failed documents, else `""`.

## Routes

Spec 553's rules: principal first, `service === null` is 503, a malformed project id is the missing-project 404,
`exactQuery` then strict zod, `Cache-Control: private, no-store`, one error mapper.

| Method, path | Input | Success | Errors |
| --- | --- | --- | --- |
| POST `/projects/:projectId/extract` | bodyLimit 1 KiB; empty or strict `{ extractor?: "rules" \| "model" }` | 200 `BrainExtractView` | 400 401 404 409 413 503 |
| GET `/projects/:projectId/claims` | `kind`; `path` (553 rules, trailing `/` = folder); `limit` 1..100 (20); `cursor` | 200 `BrainClaimsView` | 400 401 404 503 |

Extract is one bounded rules run (no git source needed); a run with a row is a 200 even when failed. Claims come
newest document first, then by span; `path` keeps documents with a path ref equal to or under it (spec 553's range, no
LIKE). Items carry quote, label, kind, spans, `stale` and the document (`kind`, `label` `#N` / short sha / title,
`title`, `permalink`, `date`, live `revision`).

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| POST `.../extract`, GET `.../claims` | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal; scope `personal:project:<id>` | as routes |
| `runBrainExtraction`, repository | server code | caller-resolved scope key; `(owner_id, scope_id)` in every statement | result and store codes |

Validation: project id pattern, bodyLimit, strict zod bodies, queries and store inputs, write-time verbatim and id
checks, strict cursor decoding, bound SQL parameters only. Errors: fixed `BRAIN_API_ERRORS` bodies with new 409s
`extractor_not_configured` and `extraction_in_progress`; other pre-run failures are logged by code and are 503
`brain_unavailable`. Logs carry names or codes, never document text, SQL or paths. No credentials or third parties.

## Integration wiring

No `server.ts`, `owner-database.ts`, route-inventory or environment changes: `/api/brain` is mounted after
`authMiddleware` and the tables ship through the existing bootstrap. `createClaimMethods(deps, resolveProject)` adds
`extract` and `listClaims` to `createBrainProjectService`. `brain/index.ts` does not re-export `claims/`.

## Failure modes

A crash mid-run keeps finished documents' claims and state, and its running row blocks the scope until the lease
expires; racing inserts from another process hit the partial unique index; a superseded run loses its fence
(`run_superseded`); a 120 s run plus one 120 s model call stays under the lease. A client abort does not stop a run.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| claims per document / scope; label / statement / quote / fields | 50 / 50,000; 80 / 1,000 / 2,000 units / 1 KiB | zod, SQL CHECK, scope count under the lock |
| per run, default / ceiling: documents; body bytes; time; model call; attempts per revision; tokens; cost | 100 (200 per request) / 500; 4 / 16 MiB; 20 / 120 s; 60 / 120 s; 3 / 10; 250,000 / 2,000,000; 1 / 50 USD | `job.ts` |
| model candidates / usage per call / quote search work per document; runs kept; claims page / cursor; in-process guard | 200 / 10,000,000 / 2^32; 50 per scope (plus runs that cost anything in the last 30 days, spec 555); 100 / 640 chars; 16 scope keys | `verify.ts`, store, route, `job.ts` |

## Invariants

- **Source of truth**: owner Postgres `brain_claims`, `brain_extraction_state`, `brain_extraction_runs`, derived from
  `brain_documents`; claims never change documents and re-extraction replaces a document's set.
- **Lock/transaction scope**: writes take the per-scope advisory lock, one transaction per document for claims and
  state, each fenced by the scope's running run id; extraction and model calls run outside transactions.
- **Acceptable orphan states**: claims of an older revision stay, flagged stale, until re-extracted; claims and state
  of an older rules version stay until the current rules version writes that document; a crashed run's running row
  stays until its lease expires; runs outlive tombstones and source deletes until `eraseScope`.
- **Auth source of truth**: the request principal and the `personal:project:<id>` scope, unchanged from spec 553.
- **Deferred scope**: the model adapter and prompt (5b), a kernel tool, UI, organization scopes, scheduled
  extraction, read-side de-duplication across extractors and claim search.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-claims-*.test.ts` (PGlite or pure, fake model only, no network) covers the
store, the rules versions (`brain-claims-upgrade.test.ts`: `rules/v1` to `rules/v2` replace with counts and no
duplicates, a scope part way through, model rows untouched, stale flags, the scope cap), the rules on real-body
fixtures (#2035, #2041, #2027, #1607, #1976, specs 008, 033, 057, 067, 084, 093, 107, 109, 534, footer and squash
bodies), one claim per quote and its kind precedence, verification, the job and the routes on a real service. Manual (dev Docker stack, after spec 553's sync):
`POST .../extract` until `nextAction` is not `run_again` (2,129 documents: 11 runs of at most 200), then `GET
.../claims?path=packages/gateway/src/onboarding/&limit=100` lists 45 claims from 9 documents (#1997, #165 to #170,
#222 and commit `4a21b4aeb574`; 54 before one claim per quote), each with Source of truth, Lock/transaction scope,
Acceptable orphan states and Auth source of truth invariants and a Deferred scope commitment that names the later
work, `#N` labels and permalinks;
`{"extractor":"model"}` is 409 `extractor_not_configured`.

## Code review checklist

Quotes slice from the stored body at their spans; claims and state change only under the lock, one transaction per
document, fenced by the run; every list, loop and `Set` is bounded; no `catch {`; no model call or new dependency.

## Delivery and evidence

- [ ] One PR under 3,000 additions and 50 files, checks green, Invariants and the OS-view matrix (N/A) in the body,
      merged only after Greptile scores its current head 5/5.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): claims, extraction runs and the two routes.

## Relationship to existing work

Spec 551 gains three tables, five repository methods and cleanup in its transactions; spec 552's documents are the
input; spec 553 supplies project resolution, route rules, path matching and its Markdown scanners; organization
scopes wait for spec 124.

## Deferred

Everything under Deferred scope above, plus claim history across revisions and erasing a deleted project's scope.
