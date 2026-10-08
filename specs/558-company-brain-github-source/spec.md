# Company Brain GitHub source

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/sources/github/`, `brain/sources/integration/`)  
**Date:** 2026-10-02

## Outcome

A project's GitHub pull requests (title, full description, state, merge time, labels, author, assignees, linked
issues, every commit sha), their reviews and review comments (each its own document linked to the pull request) and
its issues are synced into the brain store with stable ids, a cursor and one receipt per run, like the git source.
Pull request documents carry `commit` refs, so a git commit on the default branch maps to its pull request even when
its message has no `#N`. GitHub is reached through the owner's connected account (integration mode) or, on a
self-hosted gateway, a token from the environment (token mode).

## Scope of this increment

In scope: the `github` kind handler and adapter, two GitHub clients behind one small interface, the shared
`BrainIntegrationCaller`, two tables, fixtures and tests. Out of scope (no stubs): the sources runner and the
`/sources` routes (spec 560; neither PR adds a route), registry entries and startup wiring (see Integration wiring),
and everything under Deferred. OS-view surface matrix: N/A (no UI, copy or route).

## Model

- Config (`BrainGithubSourceConfig`, strict zod, mirrored by SQL CHECKs in `brain_github_sources`): `repo`
  (`owner/name`, segments `[A-Za-z0-9_.-]{1,100}`, never `.` or `..`), `mode` (`integration` or `token`),
  `accountLabel` (integration only, 1..100 characters, no control characters, no space at either end), `include` (pull
  requests, reviews, issues; reviews need pull requests; at least one of pull requests or issues) and `since` (a real
  `YYYY-MM-DD` from 2008 on; default 365 days before the first run, never more than 3,650 days back). The view adds
  nothing secret. The bounds the column CHECKs cannot state (no `.` or `..` segment, no space at either end of a
  label, a real date) are one named CHECK that the bootstrap adds `NOT VALID` to a table made before it, and every
  loaded row is parsed with the same schema, so a row the CHECKs never saw fails as `source_config_invalid` before it
  can reach a URL.
- Identity: `externalRef` is `https://github.com/<owner>/<name>` lowercased. Document ids are sha256 of
  `["brain_github_v1", externalRef, kind, key]`: `pr` and `issue` by number, `review` and `review_comment` by GitHub
  id. Never content. The adapter takes `externalRef` from the source row (`brain_sources.external_ref`) and refuses
  a config whose repository is another one (`config_invalid`), so ids always match their source.
- Repository match: a github source's repository must be the git source's github.com repository when that is known:
  the git source's ref when it is a github.com web base, else (a `project:<id>` ref, whose web base comes from origin
  on each run) the repository in one live `git_pr` or `git_commit` permalink of that source. Checked by
  `checkConfig` before the source row exists and again when the config is saved (`source_conflict`; the sources
  service then removes the new row), and at each adapter creation (`config_invalid`); unknown (no git source, another
  host, nothing synced yet) accepts any repository.
- Documents (`github_pr`, `github_issue`, `github_review`, `github_review_comment`): title (one line, at most 300
  units), the text verbatim, then a plain footer (number, state, author, merge time, labels, linked issues, commit
  count and merge commit; or reviewer and state; or path and line). Text over the store limit is cut with a marker.
  Permalinks are built from the configured repository (`/pull/N`, `/issues/N`, `#pullrequestreview-ID`,
  `#discussion_rID`). Pending reviews and comment-only reviews without text are skipped (their comments are
  documents).
- Refs: pull requests `handle` (`#N`), `pr`, `status` (merged, draft, open, closed), `author`, `assignee`,
  `reviewer` (submitted reviews and requested reviewers), `label`, `issue` (closing keywords for this repository)
  and `commit` (the merge commit once merged, then up to 100 commit shas); issues `handle`, `issue`, `status`, `author`, `assignee`,
  `label`; reviews `pr`, `parent`, `status`, `author`, `reviewer`; review comments `pr`, `parent`, `author` and
  `path` when it is a safe repository path. People are `github:<login lowercased>`. Per-kind caps follow
  `BRAIN_REFS_PER_KIND_MAX`.

## Sync algorithm

- One listing: `GET /repos/{repo}/issues?state=all&sort=updated&direction=asc&since=W&page=P&per_page=50` (issues and
  pull requests together). Cursor `gh1:` + base64url JSON: watermark `W` (GitHub second precision), tie page `P`
  (1..3), the issue numbers already applied at exactly `W` (at most 100) and, when one is open, the pull request
  still being written (its number, its `updated_at` and how many of its children are written, 1..200).
- An item is new unless it is older than `W` or listed as applied at `W`. Each pull request costs four more reads:
  details (merge commit, draft, requested reviewers), commits, reviews and review comments (two when reviews are
  off). Each item moves the cursor only once its documents are in the page.
- A page stops at 25 items, 40 provider calls (12 in integration mode), the runner's document, deletion and ref
  limits, 8 s, or the run signal, and always takes at least one item. An item that does not fit a non-empty page is
  read again on the next page. A pull request that does not fit an empty page writes its document and the first
  children that fit, and stays open in the cursor: the watermark and applied list do not move, and the next page
  writes its children from there on. It is applied (and its deletion sweep runs) only once all its children are
  written; if it changes while open, its children start over. One that cannot get further (not even one more child
  fits) is cut to fit (`items_truncated`).
- Ties: a full page whose items are all applied moves to the next tie page; more than 100 ties at one second (or a
  third full tie page) moves the watermark one second on with `items_truncated`.
- Deletions: when a pull request's review and comment lists are complete, its live children of this source that
  GitHub no longer lists are tombstoned (a bounded read of core refs, at most 500).
- A pull request that vanished between the listing and its reads is passed over.
- Conditional requests (token mode, listing only): `ETag` and `Last-Modified` are kept per source in
  `brain_github_conditional` with the hash of the cursor of the page that read them, and are only sent once that
  cursor has committed (seen at the start of a later page, or the page did not move the cursor). A 304 is an empty,
  caught-up page with the `not_modified` notice.

## Integration caller

`createBrainIntegrationCaller({ internalBaseUrl, machineToken, db, pipedream, fetch, timeoutMs })`: remote transport
when the internal URL and machine token are set, like the Jev read client (`POST {internalBaseUrl}/read-call`, machine
bearer, signed owner delegation, read scope header; a call without a label first reads the owner's connections and
uses the service's only one (several: `invalid`, never the first), cached 5 minutes, at most 256 entries; a 401 from that route is the platform refusing this gateway's machine credentials, so
it is `unavailable`, never `unauthorized`), else local when the platform database and Pipedream client are present
(`executeIntegrationAction` with the selected connection of the platform user whose Clerk id is the owner id, or whose
platform id it is; an owner with no platform user is `not_connected`; the read is a raw Pipedream proxy request,
capped at 4 MiB while it is read and cancelled by the call's signal). Only registry actions with risk `read` on
Pipedream services pass, after the registry's parameter checks; an action the registry lacks is `unavailable` (a
server gap, so `retry_later`), bad parameters are `invalid`.

## Routes

None. Connecting, syncing and listing receipts of a github source go through the `/sources` routes of spec 560,
which call this handler; the routes, their auth and their body limits are defined there.

## Security architecture

| Surface | Auth | Notes |
| --- | --- | --- |
| Kind handler and adapter | caller-resolved `BrainScopeKey` from `requireRequestPrincipal` in sources/core | never takes a bare id |
| Integration caller, remote | machine bearer plus HMAC owner delegation to the platform internal route | read scope header; platform re-checks risk |
| Integration caller, local | owner's own connection rows, found by Clerk id (or platform id) | label selection never guesses between duplicates |
| GitHub REST (token mode) | `Authorization: Bearer <MATRIX_BRAIN_GITHUB_TOKEN>` | api.github.com only, redirects refused |
| Token mode use | principal is one of the handler's `tokenOwnerIds` (the gateway's configured owner) | anyone else, such as a collaborator on a shared machine, gets `not_connected`, and availability ignores the token for them |

- Input validation: config by strict zod and SQL CHECKs; repository segments by pattern before any URL is built;
  every provider object, list and string by a bounded zod schema; review comment paths by the git source's path
  rule; ETag and Last-Modified values by pattern before they are stored or sent; cursors by schema and length.
- Error policy: adapters return source error codes only (`not_connected`, `auth_failed`, `rate_limited`,
  `remote_not_found`, `provider_unavailable`, `provider_timeout`, `provider_output_invalid`, `config_invalid`,
  `cursor_invalid`); the handler throws `source_config_invalid` and `source_conflict`. Logs carry error names, never
  provider text, tokens or document content.
- Credentials: the token is read from the environment when an adapter is created for one run, kept only in that
  closure, sent only in the Authorization header, and never stored, logged or returned. Integration credentials
  stay in the platform; the brain never sees them.

## Integration wiring

Startup (the wiring step, not these PRs): `bootstrapBrainGithubDatabase(db)` runs after the core, search and graph
bootstraps with the same lock-timeout deferral; `createBrainIntegrationCaller` gets `internalIntegrationBaseUrl`,
`UPGRADE_TOKEN`, `platformDb` and the Pipedream client from `server.ts` once platform integrations have started (the
owner database starts first, so the brain gets a small wrapper that answers `unavailable` until then);
`createBrainGithubSourceHandler({ kysely, integrations, isConnected, tokenOwnerIds })` joins the sources service's
handlers (`isConnected`, the connection lookup the connectors use, answers availability without a GitHub call;
`tokenOwnerIds`, the configured owner ids `MATRIX_USER_ID` and `MATRIX_CLERK_USER_ID`, or `default` outside production
when neither is set). Five read actions are added to the registry's github service (`list_issues_since`,
`brain_get_pr`, `brain_list_pr_commits`, `brain_list_pr_reviews`, `brain_list_pr_review_comments`; the `brain_` prefix
keeps them apart from the platform's own `get_pr` and `list_pr_*` reads). The platform's read-call failure answer
(`integrationActionFailure`) names the provider's 401/403 as `upstream: "unauthorized"` and 404/410 as `upstream:
"not_found"` in its 502 body, and answers a 403 that is a rate limit like a 429. No kernel or cross-package calls; no
`globalThis`. Config injection: `MATRIX_BRAIN_GITHUB_TOKEN` (unset by default, 20..255 characters of
`[A-Za-z0-9_.-]`), read per run.

## Failure modes

- Timeouts: 10 s per GitHub call and 15 s per integration call, each also bounded by the run signal; an abort during
  a page returns the items read so far.
- Rate limits (token mode and the local integration transport): a 429, a 403 with `retry-after` or
  `x-ratelimit-remaining: 0`, and a 403 whose message names a rate limit (GitHub's secondary limit can carry no
  headers) become `rate_limited` with `retryAfterSeconds` (1..3,600, else 60); a spent budget stops later calls of
  the run without calling. The receipt says `retry_later`.
- Concurrent runs: the runner's cursor compare-and-set lets one batch win; a losing run's validators are never
  confirmed. Validator writes take the `brain-github:<scopeId>` lock, never the core lock.
- Crash recovery: a crash between pages replays at most one page as no-ops; validators of an uncommitted page stay
  unconfirmed.
- Provider answers (token mode and the local transport): any other 401 or 403 is `auth_failed`; 404, 410 and
  redirects are `remote_not_found` (a pull request that 404s is passed over). Remote integration mode (hosted
  gateways) gets these only as the read-call route's generic 502, so they are `provider_unavailable` until that route
  names the provider's answer (`upstream`: `unauthorized` or `not_found`, read by the caller already; see Integration
  wiring); a platform 401 there is `provider_unavailable` too.
- Error propagation: expected failures are values; anything else is rethrown (the runner records `internal_error`).

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| response body | 4 MiB (GitHub and integration calls), 256 KiB connection list | `bounded-body.ts` |
| page | 50 listed, 25 items, 40 / 12 calls, 8 s, runner document and ref limits | `adapter.ts` |
| per pull request | 100 commits, 100 reviews, 100 review comments, 500 children examined | `pull-reader.ts`, `database.ts` |
| cursor | 100 applied numbers, 3 tie pages, one open pull request, 2,048 characters | `cursor.ts` |
| validators | 8 rows per source, oldest pruned | `database.ts` |
| label cache | 256 entries, 5 minutes | `caller.ts` |
| refs per document | per-kind caps, 200 total | `documents.ts` |

No files, timers or child processes. Third-party data flow: requests go to api.github.com (token mode) or through
the platform's Pipedream proxy to GitHub (integration mode), carrying only the repository, numbers, a time and page
sizes; nothing from the brain is sent to GitHub.

## Invariants

- **Source of truth**: GitHub; the brain copy is bounded and revisioned, written only through `applySyncBatch`.
- **Lock/transaction scope**: documents, refs and the cursor commit in the runner's batch transaction; config and
  validator rows commit under the feature lock; core tables are only read.
- **Acceptable orphan states**: unconfirmed validator rows (never used, pruned); documents of a disabled include
  switch until the source is removed; issues deleted on GitHub until the source is removed.
- **Auth source of truth**: the request principal and the project scope (spec 553); the owner's GitHub connection
  in the platform; the environment token on self-host, for the configured owner only.
- **Deferred scope**: see Deferred.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-source-github-*.test.ts tests/gateway/brain-integration-caller*.test.ts` (PGlite,
fake client, fake fetch, recorded-shape fixtures; no network) covers mapping, both clients, the page loop with
receipts (`succeeded`, `partial` with `retry_later`, `failed`), ties, sweeps, limits, conditional requests and the
handler. The token-mode test runs handler, REST client, adapter and store end to end. Manual (dev Docker stack,
after wiring): connect a github source for the matrix-os project in token mode, sync until caught up, check that
`brain_why` on a file lists the pull request with its description, and that a second sync answers `not_modified`.

## Code review checklist

Provider values pass a schema before use; permalinks are built, never copied; the token is in one header only; the
cursor moves only after an item's documents are in the page; validators are used only once confirmed; every list,
cache and loop is bounded; no `catch {`; no new dependency.

## Delivery and evidence

- [ ] Two PRs, each under 2,900 additions, checks green, Invariants and the OS-view matrix (N/A) in the body, each
      merged only after Greptile scores its current head 5/5: first the integration caller
      (`brain/sources/integration/`, its test and fetch helper, and this spec), then the GitHub source.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): the GitHub source and its two modes.

## Relationship to existing work

Spec 552's git source is the pattern and is not changed; spec 560's sources/core runs this adapter; PR #2078's
Company Brain store and the Slack stack (#2076 to #2079) are separate.

## Deferred

Issue and pull request conversation comments; PR file lists as `path` refs; webhooks; GitHub Enterprise hosts;
backfill when an include switch is turned on or `since` is moved earlier; removing documents when an include switch
is turned off or an issue is deleted on GitHub; repository options for the connect screen (`listOptions`); the
rebased copies of commits in rebase merges (only the pull request's own shas and the merge commit are mapped);
claims footer stripping for GitHub documents.
