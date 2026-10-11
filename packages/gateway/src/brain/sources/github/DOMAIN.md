# Company Brain GitHub source

Syncs a project's GitHub pull requests, reviews, review comments and issues into the brain store. Spec:
`specs/558-company-brain-github-source/spec.md`.

## Scope

- Owns `brain_github_sources` (one config row per github source) and `brain_github_conditional` (listing
  validators for conditional requests), the `github` kind handler and adapter, and the GitHub clients.
- Reads core tables with plain SELECTs only: the scope's git source and one of its live `git_pr` or `git_commit`
  permalinks (repository check) and the live children of a pull request document (deletion sweep). Every document write goes through the sources runner and
  `applySyncBatch`.
- Out of scope: see the spec's Deferred list (conversation comments, PR file lists, webhooks, Enterprise hosts).

## Source of truth

- GitHub is the source of truth; the brain keeps a bounded, revisioned copy. One github source per project, and
  its repository must be the git source's github.com repository when that is known (the git source's web base, or
  for a `project:<id>` git source the repository in its synced permalinks).
- Document ids: sha256 of `["brain_github_v1", externalRef, kind, number or id]` with kind `pr`, `issue`, `review`
  or `review_comment`; `externalRef` is the source row's `external_ref` (`https://github.com/<owner>/<name>`
  lowercased); a config naming another repository fails the run with `config_invalid`.
- `github_pr` documents carry every commit sha of the pull request (up to 100) plus the merge commit as `commit`
  refs; that is how git commits on the default branch map to their pull request.

## Public API

`index.ts`: `bootstrapBrainGithubDatabase`, `createBrainGithubSourceHandler` (deps: `kysely`, `integrations`,
optional `fetch`, `env`, `isConnected` and `tokenOwnerIds`), `createBrainIntegrationCaller` (from `../integration/`), the adapter,
both clients and the types and limits in `types.ts`.

## Auth and trust boundaries

- The caller (sources/core) resolves and authorizes the scope; nothing here takes a bare id without a scope key.
- Integration mode calls only registry read actions for the owner through `BrainIntegrationCaller`. Token mode reads
  `MATRIX_BRAIN_GITHUB_TOKEN` when an adapter is created for one run, and only for principals in `tokenOwnerIds`
  (the gateway's configured owner; anyone else gets `not_connected`); the token is only ever put in the
  Authorization header and is never stored, logged or returned.
- Every provider response is parsed with a bounded zod schema; permalinks are built from the configured repository,
  never copied from provider URLs. Provider text never reaches a client: failures are stable source error codes.

## Concurrency and recovery

- The cursor (`gh1:` + base64url JSON: watermark, tie page, issue numbers applied at the watermark, and a pull
  request too big for one page that is still open with its children written so far) moves with each page in the
  runner's batch transaction, so a crash replays at most one page as no-ops. An open pull request is applied, and its
  deletion sweep runs, only on the page that writes its last children.
- A page returns what it read before a provider failure; the failure comes back on the next call and ends the run
  with its code (`rate_limited` becomes a `retry_later` receipt with `retryAfterSeconds`).
- Listing validators are written under the `brain-github:<scopeId>` lock and are used only after the cursor they
  were written with has committed, so a failed batch can never be skipped by a 304.
- Config rows and validators go with their source (`ON DELETE CASCADE`). Config rows are parsed with the config
  schema when loaded, so a row written before a CHECK existed fails as `source_config_invalid`.

## Tests

`pnpm exec vitest run tests/gateway/brain-source-github-*.test.ts tests/gateway/brain-integration-caller*.test.ts`
(PGlite store, a fake GitHub client, a fake fetch and recorded-shape fixtures in `tests/gateway/fixtures/brain-github/`;
no network).
