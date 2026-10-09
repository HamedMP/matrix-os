# Company Brain graph: links and timelines

**Status:** Implementation target (graph layer of the brain stack; builds on specs 551 to 554)  
**Owner:** gateway `brain` domain (`brain/graph/`)  
**Date:** 2026-10-02

## Outcome

For any file, folder, person, spec, pull request or issue, Matrix answers "what touched this, newest first" and "what
is it linked to" with cited documents, derived from synced documents, refs and decision claims. Links are explicit or
inferred, with evidence. Owners merge or split person aliases by hand, helped by scored merge suggestions.

## Scope of this increment

In scope: `brain/graph/` (four tables, pure derivation, per-document writes, the derived index with hook reactions,
reads, service, seven routes, person merge suggestions), tests and this spec. Out of scope (no stubs): Deferred scope
under Invariants. OS-view surface matrix: N/A (a JSON API; the Company Brain app in spec 563 renders it).

## Graph model

- Entities (`brain_graph_entities`, scope level): person (`email:a@b.co`, `name:alice smith`, `github:login`), file
  and folder (paths; folders are ancestors of path refs), spec, pull_request, issue (`ENG-42`, `#123`), project and
  document. Id: `ent_` + 32 hex of `sha256(["brain_entity_v1", kind, key])`; a ref is `kind:key`. Rows keep a display
  name (200 characters) and first and last seen times, which only widen.
- Links (`brain_graph_links`, per document, which is always an endpoint): id `lnk_` + 32 hex of
  `sha256(["brain_link_v1", document, type, from, to])`. `changed` (document to file) is read from path refs.
- Derivation (`derive.ts`, pure, at most 300 links per document; a key the table would refuse is dropped):

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

- Aliases (`brain_graph_aliases`, persons only): a `name:` key merges into an `email:` entity while exactly one email
  was seen with it in live documents; `github:` keys merge only by hand. Links keep raw endpoints; reads resolve
  aliases. A merge carries the merged entity's aliases (`via_entity_id`, counted toward the cap), an unmerge (Undo)
  sends them back, and a split row stays and is never re-merged.
- State (`brain_graph_state`, per document): `(incarnation, revision)`, md5 digests of the current decision claim ids
  and of the refs, the known-ness of each path its decisions quote, the name and email pairs and the link count.

## Derived index, hooks and refresh

- `documents_changed` with ids derives those documents (removing tombstoned ones); null ids and `claims_changed` run
  one refresh; `scope_erased` deletes every graph row of the scope.
- `refresh`: tombstoned documents, then live ones missing or whose state differs, until the limit or budget is spent;
  then the project entity and a sweep of up to 1,000 unreferenced entities. A document refused at the entity limit
  stays pending. Deriving or removing a document marks outdated the documents that read what changed.

## Person merge suggestions

`merge-suggestions.ts` reads only. It scores pairs of root person entities that look like one human:

| Signal | Rule | Weight |
| --- | --- | --- |
| `same_github_login` | two GitHub noreply emails or a `github:` key with exactly the same login (`john-smith` is not `johnsmith`) | 0.95 |
| `name_matches_login` | a name equals a GitHub login, ignoring case, spaces and punctuation | 0.8 |
| `name_matches_email` | a name equals an email's local part the same way (never `noreply`, `support` and other shared parts) | 0.7 |
| `name_seen_with_email` | git trailers paired the name with the email | 0.5 + 0.4 x its share of the name's documents |
| `shared_name` | the same name was seen with both (display names or trailer pairs) | 0.7, or 0.5 for one word |

- Names under 3 letters and names or logins held by more than 4 entities give no signal. Score: `1 - product(1 -
  weight)`, at most 0.99. The entity that stays is the email, then the GitHub login, then the side with more links.
- A suggestion names both entities, the `aliasKey` to post (accepting is a `merge` on the alias route), up to 8
  pieces of evidence and the counts it would merge. A split pair is never suggested again.
- Order: score, then links, then id; keyset paged. One read scans at most 5,000 persons, split rows and pairs and
  ranks 500; past a cap it says `truncated` and leaves out any pair whose split row went unread.

## Routes

Spec 553's rules, with a project id or slug in `:projectId`: principal first, `service === null` is 503, a malformed
project ref is 404 `project_not_found`, a malformed `:entityId` is 404 `entity_not_found`, `exactQuery` then strict
zod, `Cache-Control: private, no-store` on every answer, no `app.use`.

| Method, path | Input | Success |
| --- | --- | --- |
| GET `/timeline` | `entity` (id or ref), `linkTypes` (comma list), `from`, `to` (date or ISO instant), `limit` 1..50 (20), `cursor` | `BrainTimelineView` with freshness |
| GET `/entities` | `kind`, `q` (case-insensitive prefix of key or name, a spec number or a file name; 200 chars), `limit` 1..50 (20), `cursor` | `BrainEntitiesView`: exact matches first, then newest last seen; no merged aliases and no entity without a live document behind it (the project always lists) |
| GET `/entities/merge-suggestions` | `limit` 1..50 (20), `cursor` | `{ items, nextCursor, truncated }`; registered before `/entities/:entityId` |
| GET `/entities/:entityId` | none | `BrainEntityView`: aliases, seen times over merged aliases, link count (links of live documents and a file's or folder's changes) capped at 10,000 |
| GET `/entities/:entityId/links` | `hops` 1 or 2, `types`, `direction` out, in or both, `limit` 1..200 (50), `cursor` | `BrainNeighbourhoodView` |
| POST `/entities/:entityId/aliases` | bodyLimit 2 KiB; `{ action: merge, split or unmerge, aliasKey }` | `BrainEntityView` |
| POST `/graph/refresh` | bodyLimit 1 KiB; empty or `{}` | `BrainRefreshView` |

Timelines: newest first; files match path refs exactly, folders the bytewise range brain_why uses, plus stored links
of the entity and its aliases. Neighbourhoods: direct links (a cursor never skips one), hops 2 adds the neighbours'
links; at most 100 nodes and 200 links, live documents only. Reads and pending scans run READ ONLY with a 10 s
statement deadline; at most two refreshes, hook passes included, run at once (more: 503). Cursors are bound to a
query fingerprint (another query's is 400).

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| the seven routes | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal via `BrainProjectResolver`; scope `personal:project:<id>` | 400 401 404 409 413 503 |
| hook listener `graph`, refresh | server code | the event's scope key; `(owner_id, scope_id)` in every statement | rejects, logged by name |

Validation: id patterns, bodyLimit, strict zod for every input, strict cursors, bound parameters only. Errors: fixed
bodies (`entity_not_found`, `alias_conflict`, `brain_capacity`); anything else is logged by name and answered 503.

## Integration wiring

`api/start.ts` bootstraps the graph on its own (a failure leaves only the graph off) and registers listener `graph`;
`api/feature-routes.ts` mounts the routes. Cites, read bounds and the route guard are shared (`brain/cite.ts`,
`brain/bounded.ts`, `api/feature-route-kit.ts`). No environment variables.

## Failure modes

- A lost hook is repaired by the next refresh; a crash rolls back its document; one erased mid-write is skipped.
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

- **Source of truth**: core documents, refs and claims; graph rows are derived, except manual alias rows.
- **Lock/transaction scope**: one transaction per document under `brain-graph:<scopeId>`, never the core lock; alias
  changes and the sweep take the same lock.
- **Acceptable orphan states**: unreferenced entities wait for the next sweep, nudged dependents for the next refresh.
- **Auth source of truth**: the request principal and the owner-scoped project resolver.
- **Deferred scope**: tracker-key and `@login` mentions, organization scopes, a kernel tool (562), app screens (563).

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-graph-*.test.ts` (PGlite, no network). Manual (dev Docker stack): refresh
until `caughtUp`, then a file timeline, `GET .../entities?kind=person` and a pull request's links with `hops=2`.

## Code review checklist

Derived writes under the `brain-graph:<scope>` lock, one transaction each; every read, scan and refresh capped; alias
changes fenced (`alias_conflict`); no `catch {`; strict zod under `bodyLimit`; no new dependency.

## Delivery and evidence

- [ ] Two stacked PRs under 3,000 additions each (the graph layer with its derivation and bounds tests, then the
      other graph tests), checks green, Invariants in the body, merged once Greptile scores the head 5/5.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): the graph routes, link modes and evidence, and how
      person merges and splits work.
