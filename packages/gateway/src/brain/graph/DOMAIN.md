# Company Brain Graph

Links and timelines over one project's brain: who wrote, reviewed, changed, mentioned or decided what, derived from
the synced documents, their refs and their current decision claims. Spec: `specs/557-company-brain-graph/spec.md`;
`../contracts/graph.ts` is the contract.

## Scope

- Owns four tables: `brain_graph_state`, `brain_graph_entities`, `brain_graph_links`, `brain_graph_aliases`.
- Entities: person, file, folder, spec, pull_request, issue, project, document. Ids are
  `ent_` + 32 hex of `sha256(["brain_entity_v1", kind, key])`, so a ref converts to an id without a lookup.
- Links: authored, reviewed, mentions, implements_spec, references_issue, decided_in, describes, part_of (stored per
  document) and changed (read from path refs, never stored). Each link is explicit or inferred, with evidence.
- Out of scope: writing core tables, text mentions of tracker keys or `@login` handles, person mentions in bodies,
  organization scopes.

## Source Of Truth

- The core tables (`brain_documents`, `brain_document_refs`, `brain_claims`, `brain_sources`) are read only, with
  plain SELECTs. The graph tables are derived and can be rebuilt by refresh at any time, except manual alias rows.
- `brain_graph_state` records, per document, the `(incarnation, revision)`, an md5 digest of the current decision
  claim ids and an md5 digest of its refs it was derived from (a sync can replace refs at the same revision), whether
  each path its decision quotes name was a path ref of the scope then (decided_in file links follow other documents'
  path refs), plus the name and email pairs its git trailers showed.
- Per-document rows (state, links, document entities) reference `brain_documents` ON DELETE CASCADE. Other entities
  and aliases are scope level and go on `scope_erased`.

## Public API

- `index.ts`: `bootstrapBrainGraphDatabase(db)`, `createBrainGraph({ repository, resolver, now? })` returning
  `{ service, index }` (the index is hook listener `graph`), `createBrainGraphRoutes({ service, getPrincipal })`,
  plus `deriveBrainGraph` (pure) and `brainEntityId`.
- Routes under `/api/brain/projects/:projectId/`: `GET timeline`, `GET entities`, `GET entities/merge-suggestions`
  (registered before `entities/:entityId`), `GET entities/:entityId`, `GET entities/:entityId/links`,
  `POST entities/:entityId/aliases`, `POST graph/refresh`.
- `merge-suggestions.ts`: scored pairs of person entities that look like one human (same GitHub login, a name equal
  to a login or an email local part, trailer name and email pairs, shared names), each with evidence and the counts
  it would merge. Read only; accepting is the alias route, and a split pair is never suggested again. The views and
  the `mergeSuggestions` service method are part of `../contracts/graph.ts`.
- Alias actions (`aliases.ts`): merge; split ("not the same person": the row stays, the pair is never merged or
  suggested again); unmerge (the app's Undo of a manual merge: the manual row is deleted and carried aliases go
  back, so the pair can be suggested again and a `name:` key is decided by derivation again).
- Each document checks the entity limit under the graph lock, counting every entity it would add (its own document
  entity included); one that adds none derives at the limit. A refresh that stops at the entity limit says so in
  `stopReason: "graph_capacity"`; an abort or a spent budget is no stop reason.

## Auth And Trust Boundaries

- Routes resolve the request principal first, then the project through `BrainProjectResolver` (owner scoped; a
  missing, foreign or malformed project is `project_not_found`). Every statement filters `(owner_id, scope_id)`.
- Every input passes a strict zod schema; cursors are base64url JSON bound to the query that made them; values are
  bound parameters (no LIKE). Errors are fixed bodies from `api/feature-route-kit.ts`; logs carry error names only.

## Concurrency And Recovery

- Writes run one transaction per document under `pg_advisory_xact_lock(hashtext(owner), hashtext("brain-graph:" +
  scopeId))` with `lock_timeout 5s` and `statement_timeout 15s`; never the core `brain:<scope>` lock, so syncs never
  wait on the graph.
- Hooks are nudges. `refresh` drops rows of tombstoned documents, derives missing or outdated documents (bounded by
  a document count, a wall-clock budget and the abort signal), re-reads pending until empty, then sweeps up to 1,000
  unreferenced entities. A foreign-key violation (document erased mid-write) skips that document.
- Deriving or removing a document marks outdated the documents that read it, only when what they read changed
  (children through `parent` refs, never itself; git commits whose link disagrees with a github_pr's `commit` refs),
  each set marked in one write, never a capped list. Their state row stays, so refresh re-derives a live one and
  removes a tombstoned one.
- Acceptable orphan states: entities first and last seen only widen; an entity whose last link went stays until the
  next refresh sweep, but `GET entities` never lists it: the list keeps only the project, document entities of live
  documents, files and folders a live path ref names, and entities (or keys merged into them) at an end of a link
  from a live document, so a removed source's people are not shown while they wait; dependents of a document
  derived by a hook wait for the next refresh.
- The project entity is named after the project (looked up through the resolver at each refresh sweep, at most 200
  characters); a failed lookup keeps the stored name (logged by error name) and the first one falls back to the id.
- Reads run read-only with a 10 s statement deadline (`brain/bounded.ts`); at most two refreshes run at once.
- Merge suggestions scan at most 5,000 persons, split rows and name and email pairs and rank at most 500 pairs; past
  a cap the answer says `truncated`. A name or login held by more than 4 entities pairs nothing, so one read adds at
  most 4 x 4 pairs per name; `same_github_login` needs the exact login (`john-smith` is not `johnsmith`).

## Tests

`pnpm exec vitest run tests/gateway/brain-graph-*.test.ts` (PGlite; fixtures in
`tests/gateway/helpers/brain-graph-fixtures.ts`).
