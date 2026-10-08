# Company Brain graph: links and timelines

**Status:** Implementation target (graph layer of the brain stack; builds on specs 551 to 554)  
**Owner:** gateway `brain` domain (`brain/graph/`)  
**Date:** 2026-10-02

## Outcome

For any file, folder, person, spec, pull request or issue of a project, Matrix answers "what touched this, newest
first" and "what is it linked to" with cited documents. The graph is derived deterministically from synced documents,
their refs and their current decision claims; every link says whether a structured field stated it (explicit) or text
matching found it (inferred), with the evidence. Owners can merge or split person aliases by hand, helped by scored
merge suggestions for persons that look like one human.

## Scope of this increment

In scope: `brain/graph/` (four tables, pure derivation, per-document writes, the derived index with hook reactions,
reads, service, seven routes, person merge suggestions), tests and this spec. Out of scope (no stubs): see Deferred. OS-view surface matrix: N/A
(a JSON API; the Company Brain app in spec 563 renders it).

## Graph model

- Entities (`brain_graph_entities`, scope level): person (a person key such as `email:a@b.co`, `name:alice smith`,
  `github:login`), file and folder (repository paths; folders are the ancestors of path refs), spec (spec directory),
  pull_request (decimal number), issue (`ENG-42` or `#123`), project (the project id) and document (one per derived
  document, deleted with it). Id: `ent_` + the first 32 hex of `sha256(["brain_entity_v1", kind, key])`. An entity
  ref is `kind:key`. Rows keep a display name (at most 200 characters) and first and last seen times, which only widen.
- Links (`brain_graph_links`, per document): the document that produced a link is always one of its endpoints, so a
  tombstone or erase removes exactly that document's links. Id: `lnk_` + 32 hex of `sha256(["brain_link_v1",
  document, type, from, to])`. `changed` (document to file) is read from path refs and never stored.
- Derivation (`derive.ts`, pure, at most 300 links per document; a key the table would refuse, such as a person name
  over 512 bytes, is dropped):

| Source | Links |
| --- | --- |
| git footer `Author:` | person `name:` authored, explicit |
| trailers `Co-authored-by`, `Signed-off-by` / `Reviewed-by` | authored / reviewed, explicit; `Name <email>` uses the email key and records the name and email pair |
| refs author, reviewer; assignee, attendee, participant | authored, reviewed; mentions (document to person), explicit |
| git_pr footer number; github_pr `pr`; github_issue and linear_issue `handle`; git_spec `spec` | describes; a git squash `(#N)` is inferred, a merge message or GitLab merge request explicit |
| `spec` refs of other documents | implements_spec, explicit |
| `issue` refs | references_issue, explicit |
| other `pr` refs | mentions (git: inferred); part_of for reviews and review comments |
| `parent` ref | part_of what the parent describes (pull request or issue), explicit |
| git_commit footer sha in a github_pr `commit` ref | part_of that pull request, explicit |
| text `#N` (title and message; not a number a `pr` or `issue` ref states) | mentions pull_request; after close, fix or resolve, or in a GitLab repository, an issue; inferred, 16 per document |
| text `specs/NNN-name` | mentions spec, inferred, 16 per document |
| current decision claims | decided_in from each `#N`, spec directory, own issue key and path ref of the scope the quote names, inferred, 16 per document |

- Aliases (`brain_graph_aliases`, scope level, persons only): a `name:` key merges into an `email:` entity when
  exactly one email was ever seen with that name in the scope's live documents (`single_email_for_name`); the merge
  goes when that stops holding. Email keys are the identity, so every observation of an email lands on one entity;
  `same_email` is reserved for sources that pair another key with an email. `github:` keys merge only by hand
  (`manual`). Links keep their raw endpoints and reads resolve aliases, so a merge or split rewrites no link. A merge,
  automatic or manual, moves the aliases of the merged entity along (they count toward the cap) and records the
  entity each came in through (`via_entity_id`), so a split, an unmerge or a dropped automatic merge sends them back.
  A split ("not the same person") row stays, and derivation never re-merges that key. An unmerge (the app's Undo of
  a manual merge) deletes the manual row instead, so nothing of the merge is left: the pair can be suggested again,
  and a `name:` key goes back to derivation.
- State (`brain_graph_state`, per document): `(incarnation, revision)`, an md5 digest of the current decision claim
  ids (the same SQL expression in derivation and in the pending scan), the name and email pairs, the link count.

## Derived index, hooks and refresh

- `documents_changed` with ids derives those documents (a tombstoned or missing one is removed); with null ids, and
  `claims_changed`, run one refresh; `scope_erased` deletes every graph row of the scope. All under the abort signal.
- `refresh(scope, limits)`: tombstoned documents with a state row first (every document with graph rows keeps one), then live documents missing, at another
  `(incarnation, revision)` or with a changed decision digest, by document id; re-read until none is left or the
  document limit or budget is spent; then the project entity (named after the project through the resolver; a failed
  lookup keeps the stored name) and a sweep of up to 1,000 entities nothing references.
  `freshness(scope)` counts pending documents, capped at 1,000.
- Deriving or removing a document marks outdated (state row kept) the documents that read it, only when what they read
  changed: children through `parent` refs (never itself) when what it describes changed; git_commit documents whose
  `part_of` link disagrees with a github_pr's `commit` refs. The next pass re-derives or removes them.

## Person merge suggestions

`merge-suggestions.ts` reads, never writes. It pairs person entities (each the root of its merged aliases) that look
like one human and scores each pair from these signals:

| Signal | Rule | Weight |
| --- | --- | --- |
| `same_github_login` | two GitHub noreply emails (`12345+login@users.noreply.github.com`, `login@users.noreply.github.com`) or a `github:` key with the same login, exactly (`john-smith` and `johnsmith` are two accounts) | 0.95 |
| `name_matches_login` | a name equals a GitHub login, ignoring case, spaces and punctuation | 0.8 |
| `name_matches_email` | a name equals an email's local part the same way (shared parts such as `noreply` or `support` never match) | 0.7 |
| `name_seen_with_email` | git trailers paired the name with the email | 0.5 + 0.4 x its share of the name's documents |
| `shared_name` | the same name was seen with both (display names or trailer pairs) | 0.7, or 0.5 for one word |

- A name is a `name:` key's text or a display name other than the key; names under 3 letters and names or logins
  held by more than 4 entities give no signal (a common name matches no login or email either). The score is `1 - product(1 - weight)`, at most 0.99.
- The entity that stays is the email, then the GitHub login, then the side with more stored links. Each suggestion
  names both entities, the `aliasKey` to post, up to 8 pieces of evidence and the counts it would merge (stored links
  of live documents of each side over its merged aliases, and how many entities move).
- Never merges by itself. Accepting is `POST entities/:entityId/aliases` with `{ action: "merge", aliasKey }`; a pair
  the owner split is never suggested again; a merged pair stops showing; an unmerged pair shows again.
- Order: score, then links of both sides, both descending, then suggestion id; keyset paged by a cursor bound to the
  query. One read scans at most 5,000 person entities (those `GET /entities` would list), their split rows and name
  and email pairs and ranks at most 500 pairs; past a cap the answer says `truncated`, and a pair whose split row
  went unread is left out rather than suggested again.
- Measured on the matrix-os project graph (30 persons, 20 suggestions): the top committer's four entities
  (`name:hamed`, `name:hamedmp`, `email:hamedmp@users.noreply.github.com`,
  `email:3755031+hamedmp@users.noreply.github.com`) are joined by suggestions scored 0.75 to 0.99.

## Routes

Spec 553's rules, with a project id or slug in `:projectId`: principal first, `service === null` is 503, a malformed
project ref is 404 `project_not_found`, a malformed `:entityId` is 404 `entity_not_found`, `exactQuery` then strict
zod, `Cache-Control: private, no-store` on every answer, no `app.use`.

| Method, path | Input | Success |
| --- | --- | --- |
| GET `/timeline` | `entity` (id or ref), `linkTypes` (comma list), `from`, `to` (date or ISO instant), `limit` 1..50 (20), `cursor` | `BrainTimelineView` with freshness |
| GET `/entities` | `kind`, `q` (case-insensitive prefix of key or name, a spec number or a file name; 200 chars), `limit` 1..50 (20), `cursor` | `BrainEntitiesView`: exact matches first, then newest last seen; merged aliases left out, and so is any entity no live document backs (no link from a live document, no live path ref; the project always lists) |
| GET `/entities/merge-suggestions` | `limit` 1..50 (20), `cursor` | `{ items, nextCursor, truncated }`, see Person merge suggestions; registered before `/entities/:entityId` |
| GET `/entities/:entityId` | none | `BrainEntityView`: aliases, seen times over merged aliases, link count (links of live documents, with a file's or folder's changes) capped at 10,000 |
| GET `/entities/:entityId/links` | `hops` 1 or 2, `types`, `direction` out, in or both, `limit` 1..200 (50), `cursor` | `BrainNeighbourhoodView` |
| POST `/entities/:entityId/aliases` | bodyLimit 2 KiB; `{ action: merge, split or unmerge, aliasKey }` | `BrainEntityView` |
| POST `/graph/refresh` | bodyLimit 1 KiB; empty or `{}` | `BrainRefreshView` |

Timelines: newest `source_updated_at` first, then document id, keyset paged; file timelines match path refs exactly,
folder timelines under the folder (the bytewise range brain_why uses), plus stored links of the entity and its
aliases; items carry the cite, link types, mode and up to 3 matched paths. Neighbourhoods: the center's direct links
(plus `changed` from path refs for a file or a document), paged; a page stops before the direct link that would pass
100 nodes, so its cursor skips nothing; hops 2 adds the neighbours' stored links in both directions and the `changed`
links of neighbour documents and files, descriptions, authors, specs and parent PRs first and `changed` last; at most
100 nodes and 200 links, `truncated` when a cap was hit. A `file:` or `folder:` ref may end with one "/". Reads run in
one READ ONLY transaction with a 10 s statement deadline; at most two refreshes run at once (more: 503). Cursors are
base64url JSON bound to a fingerprint of the query; another query's cursor is 400. Trailer and `Name <email>` parsing
is linear in the line length (messages are not whitespace-collapsed).

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| the seven routes | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal via `BrainProjectResolver`; scope `personal:project:<id>` | 400 401 404 409 413 503 |
| hook listener `graph`, refresh | server code | the event's scope key; `(owner_id, scope_id)` in every statement | rejects, logged by name |

Validation: project ref and entity id patterns, bodyLimit, strict zod for queries, bodies and service inputs, entity
refs checked per kind, strict cursor decoding, bound parameters only. Errors: fixed bodies from `BRAIN_API_ERRORS`
and `BRAIN_FEATURE_ERRORS` (`entity_not_found`, `alias_conflict`, `brain_capacity` for the alias cap); anything else
is logged by error name and answered 503. No credentials, no third parties, no document text in logs.

## Integration wiring

`api/start.ts` bootstraps the graph on its own (a failure leaves only the graph off), registers listener `graph` and
`api/feature-routes.ts` mounts the routes; cites, read bounds and the route guard are shared (`brain/cite.ts`,
`brain/bounded.ts`, `api/feature-route-kit.ts`). No environment variables.

## Failure modes

- A hook that is lost or fails is repaired by the next refresh; a crash mid-document rolls that document back.
- A document revised or erased while it is derived: the recorded revision is older, so it is pending again; an erase
  mid-write is a foreign-key violation and the document is skipped.
- Lock or statement deadlines (5 s and 15 s per document) reject the pass; the listener bus logs it by name.
- A client abort does not stop a refresh; its own signal and budget do.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| links per document; text mentions, decided_in, trailers, folders per document | 300; 16, 16, 32, 400 | `derive.ts` |
| entities per scope; aliases per entity; orphan sweep | 200,000 (derivation stops); 50 (409 `brain_capacity`); 1,000 per refresh | `store.ts`, `aliases.ts`, `refresh.ts` |
| refresh documents and budget | 500 and 20 s default, 5,000 and 120 s ceiling; hook ids 500, 30 s | `refresh.ts` |
| merge suggestions | 5,000 persons, splits and pairs scanned; 500 ranked; page 50; 8 evidence each | `merge-suggestions.ts` |
| pages; neighbourhood; cursors; quotes | timeline and entities 50, links 200; 100 nodes, 200 links; 512 characters; 300 units | service, `neighbourhood.ts`, `ids.ts` |
| SQL CHECKs | ids, kinds, key 512 bytes, display 200, quote 300, identities 32, link_count 300 | `database.ts` |

## Invariants

- **Source of truth**: the core documents, refs and claims; graph rows are derived and rebuilt by refresh, except
  manual alias rows, which are the owner's.
- **Lock/transaction scope**: one transaction per document under `brain-graph:<scopeId>`, never the core lock; alias
  changes and the sweep take the same lock.
- **Acceptable orphan states**: first and last seen only widen; an unreferenced entity waits for the next sweep;
  dependents nudged by a hook wait for the next refresh; aliases and other entities outlive `eraseScope` until
  `scope_erased`.
- **Auth source of truth**: the request principal and the owner-scoped project resolver.
- **Deferred scope**: tracker-key and `@login` text mentions, person mentions in bodies, organization scopes, graph
  search, a kernel tool (spec 562), the app screens (spec 563).

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-graph-*.test.ts` (PGlite, no network) covers derivation, every timeline
kind, paging and cursor binding, entities, aliases (automatic, manual, split, unmerge, conflict, cap), one- and two-hop
neighbourhoods, merge suggestions (signals, orientation, accept and split, paging, caps), hooks, tombstones, claim
changes, erase, sweep, budgets, capacity and the routes. Manual (dev Docker
stack, project `proj_db779ebd-56fb-4c55-a253-34add36251b7` after the final wiring): `POST .../graph/refresh` until
`caughtUp`, then `GET .../timeline?entity=file:packages/gateway/src/brain/why.ts`, `GET .../entities?kind=person` and
`GET .../entities/<pull request id>/links?hops=2`.

## Code review checklist

Every derived write runs under the `brain-graph:<scope>` lock in one transaction; every read, page, scan, recursion
and refresh is capped; alias changes are fenced by the alias row's state (`alias_conflict` otherwise); no `catch {`;
bodies are strict zod under `bodyLimit`; a foreign-key refusal is a skipped document, never an error; no new
dependency.

## Deferred

Everything under Deferred scope, plus entity renames across paths.
