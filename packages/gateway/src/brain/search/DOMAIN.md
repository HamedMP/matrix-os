# Company Brain Search

Ranked search over one project scope's live documents and claims: Postgres full text everywhere, and meaning search
(embeddings fused by reciprocal rank) whenever an embeddings provider is configured, over pgvector when the extension
exists and plain `real[]` arrays otherwise. Spec: `specs/556-company-brain-search/spec.md`; contract:
`contracts/search.ts`.

## Boundaries

- Owns `brain_search_documents`, `brain_search_claims`, `brain_search_vectors` (always) and, only with pgvector,
  `brain_search_chunks`: derived rows that record the `(incarnation, revision)` they came from and reference
  `brain_documents` only. Reads the core tables with plain SELECTs; never writes, alters, indexes or triggers them.
- `index.ts` exports `bootstrapBrainSearchDatabase`, `createBrainSearch` (service plus the derived index and hook
  listener `search`), `createBrainSearchRoutes` (`GET .../search`, `POST .../search/refresh` under
  `/api/brain/projects/:projectId`), the two stores (`createBrainPgVectorStore`, `createBrainArrayVectorStore`) and
  `createBrainSearchEmbeddings` (the OpenAI provider from the owner's settings, or null).
- `openai.ts` is the only code that calls OpenAI: `POST https://api.openai.com/v1/embeddings` with a bounded body,
  a timeout per attempt, `redirect: "error"`, two retries and typed errors. `openai-config.ts` reads
  `brain.embeddings` in `<home>/system/config.json` (never `tools.embeddings`, which other features use): embeddings
  are on only when the owner sets `openai_key`, to their key or to `"${OPENAI_API_KEY}"` (the gateway's key, only
  with no `OPENAI_BASE_URL`); empty or absent is off whatever the environment holds. The key is read per call, never
  logged, cached or returned. The price is kept once, in `openai.ts`.
- What goes to OpenAI: the title, body chunks and current claim statements of live documents whose provenance the
  owner allowed in `brain.embeddings.provenances` (default `git_pr`, `git_commit`, `git_spec` only), plus the text of
  each hybrid or auto search. Chat transcripts, notes, files, calendar events and connector text are sent only when
  their provenance is listed. The candidate scan, the pending count and the text read (`index-sql.ts`) all filter by
  that list, so an unlisted document is never read for embedding and never pending. The list is read again at the
  start of every refresh, freshness read and search (`currentProvenances`, `brainCurrentEmbedTarget`), so a narrowed
  list applies without a restart; settings that turned invalid or lost their key send nothing.
- Meaning search serves only the gateway owner's scopes (`embeddingOwnerIds`, the same principals as the model key):
  any other principal searches by text, sees the text-only capability, and its documents and queries are never sent.
- A refresh whose embedding pass cannot go on says why in `stopReason`: `embedding_unavailable` (the provider is
  not configured, refused the key or is unavailable) or `vector_cap`.
- `embed-pass.ts` is the refresh's embedding pass: batches across documents, the per-refresh token and cost budget,
  the store's room net of the group's own rows, and which failures stop the pass. A chunk keeps its stored vector when
  its text key (SHA-256 of the text sent) is unchanged for this provider and size, so only changed chunks are sent.
  A row counts as embedded under `<store>:<provider id>`, so a store or provider switch embeds again.
- Spend: a pass that paid logs `[brain-search] embedding spend` (tokens, cost, `stopped`, or `error` when it then
  threw), and each query embedding logs `query embedding spend`; counts only, never ids or text. The hook listener and
  the index catch-up drop the refresh result, so these logs are their only trace; a `search_refresh` job step's
  summary carries `embeddingTokens` and `embeddingCostMicroUsd`. No per-owner total or cap across refreshes yet.
- Both stores skip a write unless the document is live at the input's `(incarnation, revision)`, so a slow pass
  never replaces a newer revision's vectors.
- `snippet-plain.ts` reads stored text as plain text for snippets (markdown markup, link URLs, HTML tags and comments
  dropped, entities decoded, whitespace collapsed) and maps a stored index onto it; `snippet.ts` matches and
  highlights on that plain text only, so a word held only by dropped markup gets no highlight.
- Routes resolve the request principal's own project scope; client errors are fixed bodies, logs carry error names,
  codes, HTTP statuses and SQLSTATEs only. Query text reaches Postgres only as bound `phraseto_tsquery` parameters or
  a checked prefix lexeme. Writes take only `brain-search:<scopeId>`; a refresh drops the chunks, then the rows and
  array vectors, of tombstoned documents.

## Tests

`pnpm exec vitest run tests/gateway/brain-search-*.test.ts` (PGlite; `brain-search-embed-allow` covers the provenance
allow-list; `brain-search-pgvector` loads PGlite's pgvector
build; OpenAI is a fake fetch, never the network). With `MATRIX_TEST_POSTGRES_URL` set, `brain-search-array-store`
also runs on a disposable schema of that server. Helpers: `tests/gateway/helpers/brain-search-fakes.ts` and
`brain-search-openai-fetch.ts`.
