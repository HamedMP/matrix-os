# Company Brain Impact Brief

What a branch (or a base..head range) of a project checkout changes, and what the
Company Brain already knows about those files. Spec:
`specs/564-company-brain-impact/spec.md`; the contract is
`brain/contracts/impact.ts`.

## Scope

- Owns `brain/impact/`: the service (`service.ts`), its two routes
  (`routes.ts`), the pull request comment formatter (`comment.ts`), the git
  reads the git adapter lacks (`git.ts`), the bounded import scan (`scan.ts`,
  `imports.ts`), path rules (`paths.ts`) and brain reads (`brain.ts`, cites
  from the shared `brain/cite.ts`, only documents dated at or before the merge
  base, read-only with a 10 s statement deadline).
- Out of scope: posting the comment anywhere (an approval-gated action, later),
  fetching from a remote, tsconfig `paths` aliases, and organization scopes.

## Source Of Truth

- Git objects of the project checkout (read-only, local objects only) and the
  core brain tables (read-only). This folder owns no table, file, cache or
  timer; every answer is computed per request and nothing is kept. The only
  in-memory state is the service's count of briefs running now.

## Public API

- `index.ts` exports `createBrainImpactService(deps)`,
  `createBrainImpactRoutes(deps)`, `formatBrainImpactComment(view)`,
  `BrainImpactQuerySchema` and the `BrainImpactBrief` and `ImpactDependentTotals`
  types (aliases of the contract's `BrainImpactView` and
  `BrainImpactDependentTotals`).
- Routes, relative to `/api/brain`: `GET /projects/:projectId/impact` and
  `GET /projects/:projectId/impact/comment`, query `head` (required), `base`,
  `depth` (1 or 2, default 2: depth-2 files fill the slots depth-1 files leave).
- The view carries `dependentTotals` (`{ depth1, depth2 }`, depth2 null with
  `depth=1`): files found per depth before the dependents cap. Dependents are
  ranked by depth, then by how many files of the ring before they import, then
  by path (`BRAIN_IMPACT_LIMITS.depthDefault`, read by `IMPACT_DEPTH_DEFAULT`).
- Spec cites prefer the folder's `spec.md` document, else its newest live
  `git_spec` document.

## Auth And Trust Boundaries

- Every route resolves the request principal first, then the project through
  `BrainProjectResolver` (owner-scoped; missing, foreign and malformed projects
  are the same `project_not_found`). The scope is the project's personal brain
  scope; every SQL statement carries `(owner_id, scope_id)`.
- `base` and `head` must be a short branch name or a 7..64 hex sha. Git runs
  through the git adapter's runner rules: argv arrays, `GIT_GLOBAL_ARGS`, a
  scrubbed environment, a 15 s timeout and an output bound per call, after
  `openGitRepository` containment (checkout strictly inside the Matrix home).
- Document text is untrusted: the comment formatter drops control and format
  characters (bidi overrides, zero-width marks), escapes it (`&` too), cuts it
  and puts a zero-width space after `@` and `#` and inside `GH-1`, `://` and
  `www.`, so it cannot mention anyone, reference issues or become a link. The
  only links are `https` cite permalinks. Autolink prefixes a repository sets
  up itself (for example `JIRA-1`) are unknown here and still link. Paths go in
  one-line code spans with control and format characters shown as `?`.
- Tree paths that are not indexable (`isIndexablePath`: control characters,
  over 512 bytes) are skipped by the scan, so they never reach a grep pathspec,
  the import graph or the dependents list.
- Errors are fixed `{ error: { code, message } }` bodies; git stderr, paths and
  SQL never leave the gateway (logs carry codes and error names only).

## Concurrency And Recovery

- No writes and no locks: reads see whatever the last sync committed, so a
  brief run during a sync may mix old and new history; the next request is
  fresh. A brief whose merge base the git sync has not applied yet carries
  `brain_behind_head`.
- Limits (`BRAIN_IMPACT_LIMITS`): 500 changed files, 5,000 scanned files of at
  most 256 KiB, 32 MiB read per request, 300 dependents, 50 files with earlier
  pull requests (3 each), 50 claims per kind, 20 specs, 100 untested files,
  60,000 comment characters, a 20 s scan budget. Every cap is a notice.
- At most 4 briefs run at once per service (`IMPACT_MAX_CONCURRENT_BRIEFS`,
  route and agent tool together); one more answers `brain_unavailable` (503)
  and the count is released in `finally`.

## Tests

`pnpm exec vitest run tests/gateway/brain-impact-*.test.ts` (PGlite brain, a
fixture git repository built by `tests/gateway/helpers/brain-git-fixture.ts`,
fake runners; no network).
