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
