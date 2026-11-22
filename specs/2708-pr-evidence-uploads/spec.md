# 2708: PR evidence uploads

Ticket: [ENG-532](https://linear.app/matrix-os/issue/ENG-532)

## Goal

Engineers and agents attach live screenshots and recordings to PRs without
committing them and without a GitHub web upload. One CLI command uploads files
to R2 through a standalone Worker and posts a PR comment.

## Surfaces

Developer tooling only: `packages/pr-evidence-worker/` (Cloudflare Worker at
`evidence.matrix-os.com`) and `scripts/pr-evidence` (Node CLI). No Matrix OS
user surface changes.

## Documentation deliverables

- Contributor guide in this repo: `docs/dev/pr-evidence.md` (linked from `AGENTS.md`).
- Public site docs: deferred to
  [ENG-534](https://linear.app/matrix-os/issue/ENG-534). This is internal
  engineering tooling with no user-facing behavior, and a public page would
  advertise an internal upload endpoint. ENG-534 decides the policy for
  internal tooling under the documentation-driven development rule.

## Journey

1. `scripts/pr-evidence upload <pr> <files...> [--title ...]`.
2. CLI reads `gh auth token` and the PR head SHA (`gh --repo` pinned to the
   Worker's repo), and for each file asks for a ticket and immediately PUTs
   it, then comments on the PR.
3. Reviewers see images inline and videos as links.

## Security architecture

### Auth matrix

| Route | Caller | Credential | Check | Failure |
| --- | --- | --- | --- | --- |
| `POST /uploads` | repo writer | GitHub token (Bearer) | `GET /user`; `GET /repos/{repo}/collaborators/{login}/permission` is write/maintain/admin; `GET /repos/{repo}/pulls/{pr}` exists | 401 bad token, 403 not a writer, 404 unknown PR, 503 GitHub unavailable |
| `PUT /uploads/<key>` | holder of a ticket | HMAC-SHA256 ticket (`?t=` or Bearer) over key, type, size, login, expiry | signature, expiry (5 min), key, content type, exact length; conditional `If-None-Match: *` write | 401, 403, 415, 411, 409 overwrite |
| `GET`/`HEAD /<key>` | anyone | none (unguessable key) | key format allowlist | 404 |
| anything else | anyone | none | none | 404/405 |

- The GitHub token is used only for the three GitHub calls. It is never
  stored, logged, or echoed; the allow cache keys on its SHA-256 digest.
- Authorization source of truth is GitHub repo permission. Revocation takes
  effect within the 5-minute allow cache.

### Input validation

- `POST` body: streamed 16 KB cap, then Zod: `pr` 1..999999999, `commit`
  7-40 hex, 1-10 files, `name` 1-200 chars (display only, never in keys),
  `contentType` from the allowlist, `size` 1 byte to 50 MB.
- Allowlist: png, jpeg, webp, gif, mp4, webm, quicktime. SVG, HTML, and all
  other types are rejected and can never be served.
- Keys are server-minted (`pr-<n>/<commit7>/<128-bit base32>.<ext>`) and
  re-validated by regex on every PUT and GET.
- GitHub login is pattern-checked and URL-encoded before use; the repo comes
  from deployment config and is pattern-checked.

### Error policy

Clients get coarse JSON codes only (`unauthorized`, `forbidden`,
`authorization_unavailable`, `storage_unavailable`, ...). GitHub messages,
statuses, and R2 errors are logged server-side by error name/status and never
returned. No CORS headers: the API is for the CLI, not browsers.

### Serving

`Content-Type` from the key extension, `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline`, `Content-Security-Policy: default-src 'none';
sandbox`, `Cache-Control: public, max-age=31536000, immutable`. No listing.

## Integration wiring

- Worker bindings: R2 `EVIDENCE` -> `matrix-pr-evidence`; vars `GITHUB_REPO`,
  `PUBLIC_ORIGIN`; secret `UPLOAD_TICKET_SECRET`.
- Missing secret or bucket -> uploads 503; missing bucket -> valid-key reads
  503 (never a misleading 404).
- Typecheck: `scripts/typecheck.mjs`. Tests: root Vitest under
  `tests/pr-evidence-worker/`. CI does not deploy; the owner deploys with
  Wrangler (see the package README).

## Failure modes

- GitHub timeout (10 s `AbortSignal.timeout`) or 5xx -> 503, nothing cached.
- Ticket expires mid-upload -> 403; rerun the CLI.
- Body shorter/longer than the ticket -> rejected before or during the R2 put
  (`FixedLengthStream` plus a counting stream); a partial object is deleted.
- Concurrent PUTs to one key: the R2 write is conditional on the key not
  existing (`If-None-Match: *`), so only the first succeeds; others get 409.
- CLI fails after some uploads: uploaded objects stay and expire with the
  lifecycle rule; no comment is posted.

## Resource management

- Allow cache: 500 entries, 5-minute TTL, oldest-first eviction.
- PR existence cache: 1,000 entries, 5-minute TTL.
- Rate limiter: 60 files per login per hour, 1,000 logins, TTL eviction;
  per isolate (documented, not a global quota).
- Storage: R2 lifecycle deletes objects after 180 days.
- CLI: 10 s API timeout, 120 s per-file upload timeout, 30 s `gh` timeout,
  bounded captured output.

## Acceptance checks

- Writer uploads and the comment renders images; read-only, non-collaborator,
  and invalid tokens are refused.
- SVG/HTML uploads refused; served objects carry the headers above.
- `tests/pr-evidence-worker` covers auth, validation, tickets, serving, rate
  limiting, secret hygiene, and the CLI against the real handler.

## Risks

- Public-by-URL reads: anyone with a link can view the capture. Do not upload
  credentials or private customer content (redact first).
- Per-isolate rate limiting is soft; GitHub write access is the real gate.
