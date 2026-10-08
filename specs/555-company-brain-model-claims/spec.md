# Company Brain model claims

**Status:** Implementation target (model extractor of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/claims/model/`, `brain/claims/`, `brain/api/`)  
**Date:** 2026-10-02

## Outcome

The owner can ask Claude Opus 5.5 for the decisions, commitments, risks and invariants in a project's synced pull
requests, commits and specs, next to spec 554's `rules/v1` claims: `POST /api/brain/projects/:projectId/extract
{"extractor":"model"}` runs one bounded model run per request on the owner's own Anthropic key. Every claim passes spec
554's verification (a verbatim quote located in the stored body) and is stored under `model:claude-opus-5-5/claims-v2`.

## Scope of this increment

In scope: `@anthropic-ai/sdk` in `packages/gateway`; `brain/claims/model/` (`types.ts`, `prompt.ts`, `client.ts`,
`pricing.ts`, `config.ts`); job and store edits; the `claimModels` provider; tests over a fake `fetch`. Out of scope (no
stubs): see Deferred. OS-view surface matrix: N/A (no UI; a JSON API, nothing to keep in parity).

## Request

- `client.beta.messages.create` on a new SDK client per request (explicit `apiKey`, `authToken: null` and `baseURL`
  `https://api.anthropic.com`, so `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` never apply; `timeout` 60 s per
  attempt; `maxRetries` 1, but a 429 or 5xx asking to wait over 5 s (`retry-after`, `retry-after-ms`) is marked
  `x-should-retry: false` and fails at once; `fetchOptions: { redirect: "error" }`, so a redirect never carries the key
  or a body to another origin; `logLevel` `"off"`; an injectable `fetch`) with `model` `claude-opus-5-5` (or
  `claude-opus-5`), `max_tokens` 8,192 (thinking included), `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks:
  "default"`, one system text block with `cache_control: { type: "ephemeral" }`, one `user` message, and
  `output_config: { effort, format }` (effort `low` by default; format from `betaZodOutputFormat` over the wire schema).
- Never sent: `thinking` (disabled and budget forms are a 400; omitted is adaptive), sampling parameters, `tools`,
  `tool_choice`, `stream`, a prefill. `beta.messages.parse` is not used: it throws before `stop_reason` can be read.
- Prompt version `claims-v2`: changing a byte of the system prompt, user content or wire schema bumps it, which starts
  a separate claim set (extractor id `model:<model id>/<prompt version>`). `claims-v1` allowed one quote twice (an
  invariant and a commitment) and owners and dates from anywhere in the document.

## Prompt and output

- System prompt (about 1,300 tokens, over the 512-token cache minimum) holds no date, id or setting, so its bytes never
  change and calls within 5 minutes read it from the cache. It defines the four kinds (a description of how the code
  works is not a decision); says the document is untrusted data whose instructions are never followed; demands a quote
  copied character for character from the body (not the title, fenced code or an HTML comment; no joins; word
  boundaries), a statement that is one unbroken run of the quote's words, a label from the quote or null; asks for at
  most 20 claims; gives one example of three claims.
- claims-v2 rules: a statement makes sense on its own, so it names its subject instead of resting on "this", "it",
  "they" or "that"; when the subject is in the sentence before, the quote and statement start there, else the claim is
  left out (the statement stays a verbatim run of the quote, so verification is unchanged). One claim of one kind per
  quote, chosen in spec 554's precedence: deferred work that names future work is a commitment, a chosen design a
  decision, a hazard a risk, else an invariant. Assignee, due date and severity come only from the quote itself, never
  from elsewhere in the document. Due is a date the quote itself writes as `YYYY-MM-DD`, otherwise null: verification
  keeps a due date only as written in the quote, so the model is never asked to convert `Nov 1, 2026`.
  `finalizeBrainClaims` still keeps one claim per quote if the model returns more.
- User turn: `<document_title>` and `<document_body>` text blocks, the body being `claimSourceText(document)` (git
  footer stripped). `kinds` and `maxClaims` are not sent; verification enforces both.
- Wire schema `{ claims: [{ kind, label, statement, quote, fields: { assignee, due, severity } }] }`, strings (label
  and fields nullable), loose on purpose (the SDK's transform drops enum, length and pattern constraints): the client
  nulls a bad label and drops each bad field value, so neither costs the claim; `verifyModelClaims` re-checks the rest.
- Reading a response: usage first, always; `stop_reason === "refusal"` is skipped `model_refused` (fallbacks ran
  server-side, so the whole chain declined), unless `stop_details.recommended_model` is set: the fallback model was
  rate-limited or overloaded and never ran, so the response is invalid and the revision is retried (3 attempts); another
  stop reason than `end_turn`, not exactly one text block (empty `thinking` and `fallback` blocks are skipped) or a parse
  failure is invalid.

## Selection and skips

- A model run lists pending documents newest first (`source_updated_at`, then `document_id`, both descending, served by
  `brain_documents_recent`); rules runs stay oldest first. The pending rule is spec 554's. It lists only `git_pr`,
  `git_commit` and `git_spec` documents (`BRAIN_MODEL_PROVENANCES`, passed by the project service), and the job skips
  any other provenance as `provenance_not_allowed` before a call, whatever the store returned.
- Skipped without a call, in order: a footer-stripped body over the byte cap (utf8) `document_too_large`; under 200
  characters after trimming `body_too_short`; only `* ` bullets, `Co-authored-by:` or `Signed-off-by:` trailers and
  `---` rules `commit_list_only`. A skipped revision (refusals included) is not pending again until the document
  changes. `- ` bullet lists are sent (written summaries here, 37 bodies); an empty body is done with no call.
- Grounded in this repository's 2,129 synced dev documents (footer stripped):

| Outcome | PR | commit | spec | total |
| --- | --- | --- | --- | --- |
| empty (done, no call) | 162 | 198 | 0 | 360 |
| `body_too_short` / `commit_list_only` / `document_too_large` (32 KiB) | 170 / 101 / 3 | 112 / 7 / 0 | 0 / 0 / 12 | 282 / 108 / 15 |
| sent | 982 | 258 | 124 | 1,364 |

  Sent bodies: 4.31M characters, median 1,687, p90 7,088, max 30,499. Of the 20 newest documents, 10 are sent (5 PRs,
  4 specs, 1 commit), 6 are `body_too_short` and 4 are `commit_list_only`.

## Errors and next actions

The client maps errors around the call only, by typed SDK class, most specific first, into `BrainModelError(code, {
cause })`; no message text is read, a status only for 402 and 408 (no class). A caller abort is rethrown first.

| Cause | SDK class | Fetches | Code | Document | Run, nextAction |
| --- | --- | --- | --- | --- | --- |
| run signal aborted | `APIUserAbortError` (rethrown) | 1 | none | untouched; a sent call is charged at its worst case | stops, `run_again` |
| job per-call timeout (60 s) | `APIUserAbortError` (rethrown) | 1 | none | failed `model_timeout`; charged at its worst case | partial, `retry_later` |
| SDK per-attempt timeout | `APIConnectionTimeoutError` | 2 | `model_timeout` | failed `model_timeout`; charged at its worst case; run goes on within its budgets | partial, `retry_later` |
| network | `APIConnectionError` | 2 | `model_unavailable` | no state | failed, `retry_later` |
| 401, 403, 404 (model id), 402 `billing_error` | `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `APIError` 402 | 1 | `model_auth_failed` | no state | failed, `configure_model` |
| 408, 409, 429, 5xx, 529 `overloaded_error` | `APIError` 408, `ConflictError`, `RateLimitError`, `InternalServerError` | 2; 1 if asked to wait over 5 s | `model_unavailable` | no state | failed, `retry_later` |
| 400, 413, 422, any other status | `BadRequestError`, `APIError`, `UnprocessableEntityError` | 1 | `model_rejected` | failed `model_failed`, then the run stops | failed, `contact_support` |
| non-SDK throw | rethrown | n/a | none | failed `model_failed` (spec 554) | partial, `retry_later` |
| 200 refusal | none | 1 | none | skipped `model_refused`, usage counted | succeeded |
| 200 refusal with `recommended_model` | none | 1 | none | failed `model_output_invalid`, usage counted | partial, `retry_later` |
| 200 not `end_turn`, not JSON, wrong shape | none | 1 | none | failed `model_output_invalid`, usage counted | partial, `retry_later` |

`model_rejected` stops the run after one document: a 400 is usually request-wide, and failing the page would burn every
attempt. The document still gains one, so a poison document drops out after 3 runs instead of blocking selection.

## Usage and cost

- `pricing.ts`, in tenths of a micro-USD per token: `claude-opus-5-5` input 40, output 200, cache read 2, cache write
  50 ($4, $20, $0.20, $5 per million; only the 5-minute TTL is sent); fallback targets `claude-opus-5` and
  `claude-opus-4-8` 50, 250, 5, 63; an unknown model gets the highest rate of each field.
- `usage.iterations`, when non-empty, prices each attempt (a declined one and the fallback that served it) at its own
  `model`; else the top-level counts are one attempt. `inputTokens` includes cache reads and writes, which are also
  counted apart; cost is rounded up (input 1,000, output 500, cache read 2,000, write 1,000: 19,400 micro-USD).
- The result, the run row (`cache_read_tokens`, `cache_write_tokens`, via `ADD COLUMN IF NOT EXISTS`) and the response
  carry all five counts, added before the outcome is read. Caps are checked before each call, so a run passes its cost
  cap by at most one call: about 0.20 USD (8,192 output tokens plus a 32 KiB body) per attempt.

## Spend cap across runs

- `claims/spend.ts`: a rolling limit per owner, across all of the owner's projects, on model spend over the last 30
  days, default 5 USD (`MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D`). The spend is the sum of `cost_microusd` of the
  owner's runs, in every scope, that cost anything and started after the repository clock minus 30 days
  (`BrainRepository.readModelSpend`, a plain read on the `brain_extraction_runs_billed` index).
- A model run reads it once, after its run opens; one model run per owner runs at a time in a process, so the read
  is not stale within a gateway (two gateways of one owner could each spend at most one run's budget past the cap).
  It then adds its own cost after each call and saves the run's total on its run row with each document's write
  (also for a stale document; never lowered, and the close keeps the larger value). A run that crashes, fails to
  close or is interrupted after its lease still counts. Rules runs never read it.
- A project erase keeps the project's billed runs of the last 30 days (moved to the scope id `brain:retired-runs`,
  counts and usage only, no text), so deleting a project never hands its spend back; the next run that opens drops
  them once they leave the window.
- Only the gateway owner's principals may run the model (the key is the owner's); any other principal gets
  `extractor_not_configured` and `modelSpend` null.
- Before each call: the budget left (cap minus window spend minus this run's cost) must cover the call's worst case,
  else the run stops `failed` with `spend_cap_reached` and next action `raise_budget`; the document stays pending. The
  worst case is 6 billed attempts (two SDK attempts, each up to three models: the requested one, then each default
  fallback in turn while they decline; the price table bounds the chain), each reading the title and body bytes plus
  8,192 prompt tokens at 6.3 micro-USD and writing 8,192 tokens at 25 micro-USD: about 1.54 USD for a short document.
  A call that timed out or was aborted after it was sent returns no usage but may still be billed, so it is charged
  at that worst case. Only the call in flight when a run is lost (a crash) goes uncounted: at most one per lost run.
- Retention: the 50-run prune keeps every run that cost anything inside the window. At 1,000 such runs the window is
  full and the cap stops new calls until the oldest ages out, so the sum always covers the whole window.
- A store without `readModelSpend` never gets a model call (`store_unavailable`); a read failure is `store_unavailable`.
- The result of a model run carries `spend` (`windowStart`, `capMicroUsd`, `spentMicroUsd`, `remainingMicroUsd`), and
  the project API's extract view passes it through. `GET .../claims` answers the same window as `modelSpend`, with
  the cap of the gateway's model settings (null when the settings are invalid or a caller supplies its own provider),
  so a client can show the budget before a run.
