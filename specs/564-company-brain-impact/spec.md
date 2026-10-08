# Company Brain impact brief

**Status:** Implementation target (impact brief of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/impact/`)  
**Date:** 2026-10-02

## Outcome

Before a branch merges, the owner asks the brain what it touches: `GET /api/brain/projects/:projectId/impact?head=`.
The answer lists the changed files, the files that import them (one or two levels out, approximate), the earlier pull
requests of those files, the invariants and decisions the brain holds for them, changed code with no nearby test
change, and the spec folders touched. `GET .../impact/comment` returns the same brief as Markdown for a pull request
comment. Nothing is posted anywhere in this increment.

## Scope of this increment

In scope: `brain/impact/` (git reads, import scan, path rules, brain reads, cites, service, routes, comment formatter,
`DOMAIN.md`), tests and this spec. Out of scope (no stubs): posting the comment (an approval-gated action, later), a
kernel tool (spec 562 wraps the service), UI (spec 563), fetching from a remote, tsconfig `paths` aliases, other
languages' imports, organization scopes. OS-view surface matrix: N/A (a JSON API; the app and the agent tool show it).

## Impact model

- Range: `head` is required, `base` defaults to the default branch (`origin/HEAD`, then `main`, then `master`), and
  the diff is `merge-base(base, head)..head`. A ref is a short branch name (local branch first, then
  `origin/<name>`, then a remote-tracking name) or a 7..64 hex sha. No merge base is `invalid_request`.
- Changed files: `git diff --name-status -M -z`, at most 500; renames keep their old path; `isTest` marks test paths
  (`tests/`, `test/`, `__tests__/`, `e2e/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`).
- Dependents: one `ls-tree` of head, then `git grep -o` over chosen TS/JS files for `import`, `export ... from`,
  `require(...)` and `import(...)` with a string literal. Specifiers resolve relative paths, missing extensions,
  index files, `.js` to `.ts`/`.tsx` (and `.mjs`/`.cjs`), and workspace packages by `package.json` `name` with
  `exports` (strings, conditions, fallback arrays, one-star patterns), else `main` or deep paths. Deleted and
  renamed-from paths still count as targets, so files that still import them show up. Depth 1 imports a changed
  file; depth 2 imports a depth-1 file; changed files are never dependents. `depth` defaults to 2: depth-1 files
  come first and depth-2 files fill the slots they leave; `depth=1` lists direct importers only. Dependents are
  ranked by depth, then by how many files of the ring before they import (changed files at depth 1, depth-1 files
  at depth 2), then by path, so the 300 listed are the most affected. `via` is the first changed file in path order
  (depth 1) or the best-ranked depth-1 file (depth 2). `dependentTotals` counts the files found per depth before
  the cap (`depth2` is null with `depth=1`). `approximate` is always true.
- Scan order: files next to a changed file, then in a changed file's package, then tests, then the rest. Skipped:
  `.d.ts`, `node_modules/`, `dist/`, `build/`, `coverage/`, `vendor/`, `.next/`, `*.min.js`, files over 256 KiB, and
  paths that are not indexable (control characters, over 512 bytes), so they never reach a grep or the dependents.
- Earlier pull requests and claims come only from documents dated at or before the merge base's commit time, so a
  range the brain already synced never lists its own pull requests or decisions as history.
- Earlier pull requests: per changed path (non-test first, at most 100 paths), the newest `git_pr` and `github_pr`
  documents with that exact path ref, one per label (a `git_pr` and a `github_pr` of the same number are one pull
  request), 3 per file, 50 files.
- Invariants and decisions: current claims (claim revision and incarnation equal the live document's) of live
  documents with a path ref equal to a changed or renamed-from path, newest document first, one per claim id and per
  normalized label and statement, 50 per kind, each with up to 20 of the changed paths it touches.
- Untested (approximate): changed code that is not deleted and not a test, with no changed test that imports it (from
  the scan) or whose name holds the file's name as a dash-separated part (`brain-why.test.ts` covers `why.ts`).
  Folder placement alone never counts. At most 100.
- Specs touched: `specs/<name>/...` paths grouped by folder (20 folders, 20 paths each), each cited by the folder's
  live `git_spec` document for `spec.md`, else its newest live `git_spec` document (a folder may also index
  `plan.md`, `research.md`, `data-model.md` and `quickstart.md`), or null when the brain has none. For a file split
  into parts, the cite is part 1.
- Cites follow the shared rule in `brain/cite.ts`; brain reads run read-only with a 10 s statement deadline. Notices: `changed_files_capped`, `dependents_capped`, `scan_capped`, `read_budget_exhausted`,
  `run_budget_exhausted`, `no_git_source`, and `brain_behind_head` when the git sync has not applied the merge base.

## Comment format

Pure Markdown under 60,000 characters: a heading with head and base, the merge base, then only the non-empty
sections in this order, so a cut never hides the warnings or the claims: notes, changed files, invariants with their
quotes, decisions, specs, untested code, earlier pull requests, importing files (the heading gives the counts per
depth, then 30 lines and "and N more" counted from those totals); a
footer says the import list and the test coverage are approximate. Paths go in one-line code spans (control
and format characters become `?`); document text is one line, cut, stripped of control and format characters (bidi
overrides, zero-width marks), Markdown-escaped (`&` too, so no entity spells `@` or `#`), with a zero-width space
after `@` and `#` and inside `GH-1`, `://` and `www.` so it cannot mention anyone, reference issues or become a link.
Links only for `https` cite permalinks. A cut body ends with a marked line and `truncated: true`.

## Routes

Spec 553 rules with the feature rules of `contracts/common.ts`: principal first, `service === null` is 503, a
project id or slug (`BRAIN_PROJECT_REF_PATTERN`) else 404, `exactQuery` then a strict schema, `Cache-Control:
private, no-store` per handler, no `app.use("*")`.

| Method, path | Query | Success | Errors |
| --- | --- | --- | --- |
| GET `/projects/:projectId/impact` | `head` (required), `base`, `depth` 1 or 2 | 200 `BrainImpactView` | 400 401 404 409 503 |
| GET `/projects/:projectId/impact/comment` | same | 200 `{ markdown, truncated }` | 400 401 404 409 503 |

Errors: `invalid_request` (400), `project_not_found` and `git_ref_not_found` (404), `checkout_unavailable` (409: no
checkout, not a repository, shallow, outside home), `brain_unavailable` (503: git timeout or failure, store outage).

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| GET `.../impact`, `.../impact/comment` | `authMiddleware`, `requireRequestPrincipal` | project of the principal via `BrainProjectResolver`; scope `personal:project:<id>` | fixed bodies above |
| `createBrainImpactService` | server code | caller passes the owner id; every SQL statement carries `(owner_id, scope_id)` | `BrainApiError`, `BrainFeatureError` |

- Input validation: project ref pattern; `base`/`head` at most 200 characters and a safe branch name or hex sha;
  `depth` 1 or 2; unknown or repeated query keys refused. Git argv is built from validated values and resolved shas
  only, after `--end-of-options` or a full sha; pathspecs are literal (`--literal-pathspecs`) and indexable.
- Git runs with the git adapter's rules: `openGitRepository` containment (checkout, git dirs and alternates strictly
  inside the Matrix home), `GIT_GLOBAL_ARGS`, scrubbed environment, no network, no working tree, never `HEAD`.
- Error policy: fixed messages; git stderr, paths and SQL are never returned; logs carry codes and error names only.
- Credentials: none. No tokens, no remote calls, no third parties.

## Integration wiring

- Startup: `api/start.ts` builds `createBrainImpactService({ repository, resolver })` (no bootstrap, no tables) as
  `BrainServices.impact`; `api/feature-routes.ts` mounts the routes with the shared guard.
- Cross-package: the kernel and MCP tools (spec 562) call the service or the HTTP route; nothing uses `globalThis`.
- Config: none. The runner defaults to the git adapter's `defaultGitRunner`; limits are constants in the contract.

## Failure modes

- Timeouts: every git call 15 s (`gitTimeoutMs`); the import scan stops between chunks at 20 s (`runBudgetMs`) with
  `run_budget_exhausted`. Database reads are bounded queries without locks.
- Concurrent access: each request has its own git runs and maps; the only shared state is the service's count of
  running briefs (at most 4; one more answers `brain_unavailable` 503 until one ends, released in `finally`). A sync
  running at the same time can make a brief mix old and new history; asking again gives a fresh answer.
- Crash recovery: nothing is written, so there is nothing to repair.
- Error propagation: git failures become `checkout_unavailable`, `git_ref_not_found` or a logged 503; other errors
  reach the route's mapper (no catch-and-ignore; a `package.json` that is not JSON is skipped and logged by name).

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| changed files / dependents / untested / specs (paths each) | 500 / 300 / 100 / 20 (20) | `service.ts`, `imports.ts`, `paths.ts` |
| scanned files / bytes per file / bytes per request | 5,000 / 256 KiB / 32 MiB (sizes from `ls-tree`) | `scan.ts` |
| package manifests / grep paths per call / import edges | 100 / 400 / 200,000 | `scan.ts`, `imports.ts` |
| git output: diff / ls-tree / grep per call / small | 16 MiB / 16 MiB / 4 MiB / 64 KiB (truncated output is cut at a record) | `git.ts` |
| earlier PRs / claims / claim rows read | 3 per file, 50 files / 50 per kind / 200 per kind | `brain.ts` |
| comment | 60,000 characters | `comment.ts` |
| briefs running at once (route and agent tool together) | 4, then 503 `brain_unavailable` | `service.ts` |

No files, timers or caches are created. No data leaves the gateway.

## Invariants

- **Source of truth**: git objects of the checkout and the core brain tables, both read-only; the brief is computed
  per request and never stored.
- **Lock/transaction scope**: none; plain SELECTs without locks, git reads without a working tree.
- **Acceptable orphan states**: none, because nothing is written.
- **Auth source of truth**: the request principal and the project resolver's owner-scoped lookup.
- **Deferred scope**: posting the comment (approval-gated, later), a cache of import graphs, tsconfig `paths`, other
  languages, organization scopes, a GitHub check run.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-impact-*.test.ts` (PGlite brain, a fixture repository with two workspace
packages, a squash PR, a feature branch that adds, changes, renames and deletes files; fake runners for failures; no
network) covers every section, notice and error. Manual (dev Docker stack, after wiring and spec 553's sync and 554's
extraction): `GET /api/brain/projects/proj_db779ebd-56fb-4c55-a253-34add36251b7/impact?head=<branch>&depth=2` lists
changed files, importing files with `via`, earlier PRs with `#N` permalinks and the invariants of those PRs;
`.../impact/comment?head=<branch>` returns Markdown under 60,000 characters. A local run over this repository (116
changed files, 5,046 source files) answers in about 5 s with `dependents_capped` and `read_budget_exhausted`. On
the last 10 commits of main (257 changed files) the scan finds 1,076 direct and 618 depth-2 importing files in about
2 s and lists the 300 that import the most changed files; on the last commit (71 changed files) it lists all 210
direct importers and the first 90 of 272 depth-2 files.

## Code review checklist

Every git argv is built from validated input or a resolved sha; every git call has a timeout and an output bound;
every list, set and loop is capped; no `catch {`; document text in the comment is escaped and mention-safe; no
write to any table; no new dependency.

## Delivery and evidence

- [ ] One PR under 3,000 additions, checks green, Invariants and the OS-view matrix (N/A) in the body, merged only
      after Greptile scores its current head 5/5.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): the impact brief and its two routes.

## Relationship to existing work

Spec 552 supplies the git runner, containment and the path, PR and spec refs; spec 553 the route rules and the
footer parser for cites; spec 554 the claims. Spec 562 wraps the service as the `brain_impact` agent tool and spec
563 shows it in the app.

## Deferred

Everything under Deferred scope above.
