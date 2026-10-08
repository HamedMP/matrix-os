# Company Brain search

**Status:** Implementation target (search layer of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/search/`)  
**Date:** 2026-10-02

## Outcome

The owner asks one question of a project's brain and gets ranked, cited answers: documents (pull requests, commits,
specs and every later source) and claims (invariants, decisions, commitments, risks), each with a plain-text snippet
and highlight ranges. Full text works on every Postgres. Meaning search (embeddings fused with full text) turns on
when the owner gives an OpenAI key: vectors live in pgvector when the extension exists, else in plain `real[]`
arrays on stock Postgres. Without a key, search is full text only and behaves exactly as before.

## Scope of this increment

In scope: `brain/search/` (tables, bootstrap with pgvector detection, derived index and hook listener, query parser,
ranking, snippets, cites, embeddings seam, the OpenAI embeddings provider and its settings, pgvector and array
stores, reciprocal-rank fusion, service, two routes), tests and this spec. Out of scope (no stubs): see Deferred.
OS-view surface matrix: N/A (a JSON API; the brain app, spec 563, renders it). Views, query fields, limits, field
weights and seams are `contracts/search.ts`; this spec adds the rest.

## Search model

- One idempotent bootstrap under the `brain_search_schema` lock (`lock_timeout 5s`, `statement_timeout 30s`) creates
  `brain_search_documents` (per document: `incarnation`, `revision`, `claims_key`, `embedded_provider`,
  `embed_failed_at`, `tsv`) and `brain_search_claims` (per claim: `kind`, `incarnation`, `revision`, `tsv`), GIN on
  both `tsv`. They reference `brain_documents` `ON DELETE CASCADE`, never `brain_claims`, so no search write locks a
  claim row.
- `brain_search_chunks` exists only when `CREATE EXTENSION IF NOT EXISTS vector` succeeds (in a savepoint); SQLSTATE
  `0A000`, `58P01` and `42501` are logged and reported as `extension_missing`, anything else fails the bootstrap.
  Chunks follow `BRAIN_SEARCH_CHUNK` (cut at a newline or space in the back half) in a free-dimension `vector` column
  checked against `dimensions` (1..4,096).
- `brain_search_vectors` always exists (same keys, provider, `dimensions`, `created_at`, no spans): `embedding REAL[]`
  with a CHECK for one dimension, `cardinality = dimensions`, no NULL, and every value in [-1.0001, 1.0001] (so no
  NaN or infinity). Vectors are scaled to unit length on write (a zero vector is not stored) and rounded to float4.
- Both vector tables keep `text_key` (the first 32 hex characters of the SHA-256 of the chunk text sent; added with
  `ADD COLUMN IF NOT EXISTS`), so a chunk whose text is unchanged keeps its vector. A store write runs, under the
  search lock, only while the document is live at the input's `(incarnation, revision)`; otherwise it changes nothing.
- Store choice: the pgvector store when the bootstrap found the extension, else the array store. Capability `vector`
  is `available` when a provider with sane bounds and a store exist, and then the view also carries `store`
  (`pgvector` or `array`). Off, the capability is unchanged: `provider_not_configured` with pgvector,
  `extension_missing` without.

## Index

- Pending: a live document with no row, or a row of another `(incarnation, revision)`, another `claims_key` (md5 of
  the document's claim ids, extractors, revisions and spans) or, with meaning search on, not embedded under the
  current store and provider (`embedded_provider` holds `<store>:<provider id>`, so a switch of either re-embeds).
  `freshness` counts pending documents, tombstoned ones with rows left included, up to 1,000.
- `refresh` first drops the chunks, then the document rows, claim rows and array vectors of tombstoned documents in
  one transaction (a failure leaves the rows for the next refresh); the array vectors go even with no provider. Text
  pass: outdated rows in id order, 25 documents per transaction, text vectors computed by Postgres in the statement
  that records the revision. Embedding pass (meaning search on): see Embeddings. Defaults 500 documents and 20 s
  (ceilings 5,000 and 120 s), signal and budget checked before each batch and each provider call.
- Hooks: `documents_changed` and `claims_changed` refresh the listed ids (at most 500, malformed ids ignored) or, with
  null ids, the whole scope (bounded); `scope_erased` deletes any leftover rows of the scope.

## Embeddings

- Texts per document: up to 39 body chunks, then one chunk of the statements of its current claims (distinct, joined
  by newlines, at most 2,000 characters), each led by the title. A vector match on that chunk finds the document;
  its snippet is the usual one. New claims make the document pending, but only chunks whose text key the store does
  not hold for this provider and size are sent: a claims change sends the claims chunk alone, the same statements
  from another run send nothing, and a body edit sends only the chunks it changed. The rest keep their vectors.
- Pass: rows at their live revision without this provider's vectors, never-tried first, then oldest failure, read a
  batch at a time; documents are grouped so one call carries up to a full batch of chunks. Before each call: signal,
  time budget, the refresh's budget (1,000,000 tokens and 20,000 micro-USD; one call can pass it by one batch), and the
  store's room not counting the rows the group's own documents hold (their write replaces them). Every vector is checked (count, length, a float4 number) and every usage figure (a non-negative
  integer). Failures: `not_configured`, `auth_failed` and `unavailable` end the pass and record nothing; any other
  failure of several documents retries them one by one; one document's failure is recorded on its row
  (`embed_failed_at`) and ends the pass. A refresh with meaning search on answers `embedding: { tokens,
  costMicroUsd, stopped }` (`stopped`: `budget`, `vector_cap` or null).
- Spend trace: every pass that paid logs `[brain-search] embedding spend` with its tokens, cost and `stopped` (`error`
  when it then threw), whatever ran it (the refresh route, the hook listener, a job step, the index catch-up), and
  every query embedding logs `query embedding spend` with its tokens and cost. Counts only, never ids or text. A
  `search_refresh` job step's summary adds `embeddingTokens` and `embeddingCostMicroUsd`. Each refresh has its budget,
  but nothing caps the number of refreshes or keeps a per-owner total yet.
- Provider (`openai.ts`): `POST https://api.openai.com/v1/embeddings` with `{ model: "text-embedding-3-small",
  input, dimensions, encoding_format: "float" }`, `Authorization: Bearer <key>`, `redirect: "error"`, a 10 s timeout
  per attempt inside the 10 s deadline per batch. At most 32 inputs of at most 2,730 UTF-16 units: a unit is at most
  3 UTF-8 bytes and a token covers at least one byte, so each input stays under OpenAI's 8,192 tokens and each
  request under its 300,000. The answer is read up to 2 MiB, sorted by `index` and checked (count, length, numbers).
  Provider id `openai/text-embedding-3-small/<dimensions>`; a change of size re-embeds.
- Errors: 400, 413, 422 `invalid`; 401, 403, 404 `auth_failed`; 429 for quota (any code but `rate_limit_exceeded`)
  and everything else `unavailable`. 408, 409, 429 rate limits, 500, 502, 503, 504, network failures and attempt
  timeouts are retried twice after `retry-after-ms`, else `retry-after` (seconds or a date), else 250 ms doubling
  with jitter; a wait over 2 s, or `x-should-retry: false`, fails at once. A caller abort is rethrown untouched. Only
  the status and the provider's error code (a short slug) are kept; never its message, which can echo the key.
- Cost: $0.02 per million tokens (`BRAIN_OPENAI_EMBEDDINGS_MICRO_USD_PER_MILLION_TOKENS = 20,000`, source
  https://developers.openai.com/api/docs/pricing, read 2026-10-02), from `usage.total_tokens`, rounded up per answer.
  The dev project (2,129 documents, about 5.4M characters) costs about $0.03 to embed once.
- Settings: `brain.embeddings` in `<home>/system/config.json`, apart from `tools.embeddings` (a key set up for
  another feature never turns this on): `openai_key`, `model` (only `text-embedding-3-small`), `dimensions`
  (1..1,536, default 256), `provenances` (which documents may be sent: 1..32 known provenances, each once; default
  `git_pr`, `git_commit`, `git_spec`). A present but wrong value turns embeddings off and is logged by field name. `openai_key` is the owner's choice: their key (`sk-...`), or `"${OPENAI_API_KEY}"` (the
  `${VAR}` form of the `tools.web` keys) to use the gateway's `OPENAI_API_KEY` when it looks like a key and
  `OPENAI_BASE_URL` is unset or blank. Empty (as shipped), null or absent is off, whatever the environment holds. The
  settings are read at start (no key: no provider) and the key again on every call (a removed key is
  `not_configured`; adding one takes effect at the next start). `provenances` is read again at the start of every
  refresh, freshness read and search, so a narrowed list stops sending at once; settings that turned invalid or lost
  their key send nothing.
- Owner only: the key is the gateway owner's, so meaning search serves only the owner's principals (the same list
  that may use the model key and `MATRIX_BRAIN_GITHUB_TOKEN`). Any other principal searches by text and sees the
  text-only capability; its documents are never embedded and its queries never sent.
- A refresh whose embedding pass cannot go on (`embedding_unavailable`: the provider is not configured, refused the
  key or is unavailable; `vector_cap`) says so in `stopReason`, so a background run stops instead of retrying.
- Allow-list: the refresh lists, reads and sends only documents whose provenance the owner allowed
  (`brainEmbedProvenances`; a provider without a valid list gets the git default), and a document of any other
  provenance is never pending for vectors, so freshness still reads caught up. Vectors stored before a provenance was
  dropped from the list stay until that document changes or the scope is erased; nothing new is sent for it.
- Array store nearest: in SQL, `1 - (SELECT sum(a * b) FROM unnest(embedding, $query::float8[]) t(a, b))` over the
  scope, provider and size, joined to live documents at the indexed revision, `SET LOCAL jit = off`, under the 10 s
  search deadline. Measured at 20,000 rows of 256 dimensions: Postgres 16 305 ms (scoring batches in code: about
  1.1 s, mostly parsing `real[]` text); PGlite 0.9 s (code: about 0.8 s). Customers run Postgres, so SQL. A scope
  holds at most 50,000 rows (about 0.8 s): the pass stops before a call that would not fit, and a write past the cap
  is refused with the old rows kept.

## Query

- Terms: letters, digits, marks and the joiners `. _ - @ / # + :` stay inside a term ("package.json", "ENG-42"); a
  trailing `*` makes the last piece a prefix when it is a joined token or has 2+ characters. A word or phrase becomes
  `phraseto_tsquery('simple', term)`, a prefix `to_tsquery('simple', '<piece>':*)` of only those characters; Postgres
  keeps path tokens whole, so a joined prefix ("src/brain*") ORs the whole-token prefix with its word parts. Common
  English stop words leave plain terms (unless every term is one; phrases keep them); a plain word of 4+ letters is a
  prefix of its light stem ("grants" and "grant" both `grant:*`). All terms are ANDed; when that finds fewer than 5
  hits and there are 2+ different terms, any term matches, the score ranks the fuller matches first and the view
  carries the notice `any_term_fallback`. Filters: `kinds=document` also matches provenances outside the shared
  table; `from` / `to` take `YYYY-MM-DD` or an ISO instant with an offset; `path` follows spec 553.
- Text mode: score `ts_rank_cd(tsv, query, 32)` rounded to 6 decimals, best first, then hit id; keyset cursor on
  `(score, hitId)`. One hit per claim id (its id is the claim id): a claim both extractors hold shows once, the
  model's row first. A row counts while its document is live in the same incarnation (`index_behind` reports lag).
- Hybrid: text top 200 plus the nearest 200 chunks, one hit per document at its best chunk, filters re-applied in
  SQL, fusion divided by the best possible sum, a window of 200 paged by offset (`candidates_capped` when a retriever
  filled its window). `mode=hybrid` or a hybrid cursor without meaning search or with a failing provider is 409
  `vector_search_unavailable`; in `auto` without a cursor a provider failure falls back to text. Vector store and
  database errors are 503. A cursor keeps its first page's mode and carries a 16-hex sha256 fingerprint of the query,
  filters and mode (another query's cursor is invalid).
- Snippets are cut from the plain reading of the stored text (`snippet-plain.ts`), never `ts_headline`. It drops
  markdown markup (heading hashes, list bullets, task boxes, quote markers, rules, table pipes, emphasis marks,
  backticks), link and image URLs, link definitions, HTML tags and comments; it keeps link and image text, inline
  code text and fenced code lines, resolves escapes and common entities, and collapses whitespace to single spaces.
  Highlights index that plain text: escaped word-part patterns with Unicode word boundaries (a prefix term highlights
  the whole word it starts), at most 256 matches per field, a window around the densest matches (40 units of lead,
  snapped to whitespace, never splitting a surrogate pair; only whole matches are highlighted). So a word held only by
  a dropped URL or comment gets no highlight (the next field is tried, else the first field shows from its start), and
  a vector-only hit starts where its best chunk's span start lands in the plain text. Documents use body then title;
  claims use statement, then quote, then label (field `label`, so a claim matched only by its label shows the label
  highlighted). Cites follow the shared rule in `brain/cite.ts`.
