# Company Brain Graph

Links and timelines over one project's brain (who wrote, reviewed, changed, mentioned or decided what), derived from
synced documents, their refs and current decision claims. Spec: `specs/557-company-brain-graph/spec.md`; contract:
`../contracts/graph.ts`; tests: `tests/gateway/brain-graph-*.test.ts` (PGlite; fixtures in `tests/gateway/helpers/`).

## Boundaries

- Owns `brain_graph_state` (what each document was derived from), `brain_graph_entities`, `brain_graph_links` and
  `brain_graph_aliases`: derived and rebuilt by refresh except manual alias rows; core tables are read only.
  Per-document rows cascade with `brain_documents`; other entities and aliases go on `scope_erased`.
- `index.ts`: `bootstrapBrainGraphDatabase`, `createBrainGraph` (`{ service, index }`, hook listener `graph`),
  `createBrainGraphRoutes`, `deriveBrainGraph` and `brainEntityId`. Routes resolve the principal, then the owner's
  project (`BrainProjectResolver`); every statement filters `(owner_id, scope_id)`; strict zod, fixed error bodies.
- Aliases: merge, split (never re-merged or suggested) and unmerge (Undo); at most 50 merged per entity, listed first.

## Concurrency And Recovery

- One transaction per document under `brain-graph:<scopeId>` (lock 5 s, statements 15 s), never the core lock; a
  document erased mid-write is skipped. Hooks are nudges; a bounded `refresh` derives what is missing or outdated.
- Reads and pending scans run read only under a 10 s deadline (`brain/bounded.ts`) and skip tombstoned documents'
  links; at most two refreshes run at once across the service, the index and hooks; `scope_erased` never waits.
