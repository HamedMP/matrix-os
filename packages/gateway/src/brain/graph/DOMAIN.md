# Company Brain Graph

Links and timelines over one project's brain (who wrote, reviewed, changed, mentioned or decided what), derived from
synced documents, their refs and current decision claims. Details: `specs/557-company-brain-graph/spec.md`; contract:
`../contracts/graph.ts`.

## Scope

- Owns `brain_graph_state`, `brain_graph_entities`, `brain_graph_links` and `brain_graph_aliases`. Entity ids are
  `ent_` + 32 hex of a sha256 of kind and key, so a ref converts without a lookup. Links are stored per document,
  except `changed` (read from path refs); each is explicit or inferred, with evidence.

## Source Of Truth

- Core tables are read only. Graph tables are derived and rebuilt by refresh, except manual alias rows.
  `brain_graph_state` records what each document was derived from: revision, claim and ref digests, the known-ness
  of the paths its decisions quote, and trailer name and email pairs.
- Per-document rows reference `brain_documents` ON DELETE CASCADE; other entities and aliases go on `scope_erased`.

## Public API

- `index.ts`: `bootstrapBrainGraphDatabase(db)`, `createBrainGraph({ repository, resolver, now? })` returning
  `{ service, index }` (hook listener `graph`), `createBrainGraphRoutes({ service, getPrincipal })`,
  `deriveBrainGraph` (pure) and `brainEntityId`; seven routes under `/api/brain/projects/:projectId/`.
- Aliases: merge, split (never merged or suggested again) and unmerge (Undo); at most 50 per entity, automatic and
  carried ones included. Merge suggestions are read only.

## Auth And Trust Boundaries

- Routes resolve the principal, then the project through `BrainProjectResolver` (owner scoped, else
  `project_not_found`); every statement filters `(owner_id, scope_id)`. Strict zod for every input, cursors bound to
  their query, bound parameters only, fixed error bodies, error names only in logs.

## Concurrency And Recovery

- Writes: one transaction per document under `brain-graph:<scopeId>` (lock 5 s, statements 15 s), never the core
  lock. A foreign-key violation (erased mid-write) skips the document.
- Hooks are nudges. `refresh` removes tombstoned documents' rows and derives missing or outdated ones within a
  document count, a budget and the abort signal, then sweeps up to 1,000 unreferenced entities and names the project
  entity. A document refused at the entity limit (counted under the lock) stays pending while the pass goes on.
  Deriving or removing a document marks outdated, one write per set, the documents that read what changed.
- Reads and refresh pending scans run read only with a 10 s statement deadline (`brain/bounded.ts`); stored links of
  tombstoned documents are left out before any page or cap. At most two refreshes run at once across the service,
  the index and hook passes; `scope_erased` never waits.

## Tests

`pnpm exec vitest run tests/gateway/brain-graph-*.test.ts` (PGlite; fixtures in `tests/gateway/helpers/`).
