# PR evidence Worker

Cloudflare Worker at `evidence.matrix-os.com` that stores PR screenshots and
recordings in R2, so captures can be attached to PRs without committing them.
Uploads are authorized with the caller's existing GitHub token: anyone with
write access to `HamedMP/matrix-os` can upload; nobody else can. Spec:
[`specs/2701-pr-evidence-uploads/spec.md`](../../specs/2701-pr-evidence-uploads/spec.md).

## Usage

```bash
scripts/pr-evidence upload 1234 web-desktop.png electron-desktop.png journey.mp4 \
  --title "Web Desktop + Electron Desktop"
```

- Signs in with `gh auth token`; you need repo write access.
- Commit defaults to the PR head (`gh pr view --json headRefOid`); override with `--commit <sha>`.
- Posts one PR comment. `--no-comment` prints the markdown instead.
- Images render inline (`![name](url)`). Videos are posted as bare links on their
  own line: GitHub only plays videos inline for its own `user-attachments`
  uploads, so external videos show as a link that opens in the browser.
- Types: png, jpg/jpeg, webp, gif, mp4, webm, mov. Max 10 files per call, 50 MB each,
  60 files per GitHub login per hour.
- `MATRIX_PR_EVIDENCE_URL=http://localhost:8787` points the CLI at `wrangler dev`.

## API

| Route | Auth | Behavior |
| --- | --- | --- |
| `POST /uploads` | `Authorization: Bearer <GitHub token>` | Body `{ pr, commit, files: [{ name, contentType, size }] }` (16 KB cap, 1-10 files). Checks the token with GitHub (`/user`, collaborator permission must be write/maintain/admin, PR must exist). Returns per file `{ key, url, uploadUrl, ticket, expiresAt }`. |
| `PUT /uploads/<key>` | `Authorization: Bearer <ticket>` | Streams the body to R2. The ticket is an HMAC-signed, 5-minute grant bound to the exact key, content type, and byte length. No overwrites. |
| `GET`/`HEAD /<key>` | none | Serves the object with immutable caching, `nosniff`, `Content-Disposition: inline`, `CSP: default-src 'none'; sandbox`. Content type comes from the key's extension, never from stored metadata. Supports `Range`. Unknown keys 404; nothing is listable. |

Keys are `pr-<n>/<commit7>/<26-char base32 of 128 random bits>.<ext>`. Reads are
public to anyone holding the URL, which is unguessable.

### Why upload through the Worker instead of R2 presigned URLs

R2's S3 presigning can sign `Content-Type`, but binding the exact
`Content-Length` is not reliably enforced, and it would need R2 S3 access keys
as Worker secrets plus a new signing dependency. Streaming through the Worker
with a signed ticket enforces type and exact size in code, needs one secret,
and adds no dependencies. Request bodies are capped at 50 MB, below the
Workers request-size limit on every plan.

### Rate limiting

A fixed one-hour window per GitHub login, counted when tickets are issued,
held in a bounded in-memory map (1,000 logins, TTL eviction). It is per Worker
isolate, so it bounds bursts rather than enforcing a global quota. The real
gate is GitHub write access; a Durable Object counter can replace this if
abuse appears. The GitHub allow decision is cached by SHA-256 of the token for
at most 5 minutes (bounded to 500 entries); denials are never cached.

## Owner setup (one time, run by the owner)

Nothing here is automated, and CI never deploys this Worker.

1. Create the bucket:

   ```bash
   cd packages/pr-evidence-worker
   pnpm exec wrangler r2 bucket create matrix-pr-evidence
   ```

2. Expire objects after 180 days:

   ```bash
   pnpm exec wrangler r2 bucket lifecycle add matrix-pr-evidence expire-evidence-180d --expire-days 180 --force
   pnpm exec wrangler r2 bucket lifecycle list matrix-pr-evidence
   ```

   Dashboard equivalent: R2 -> `matrix-pr-evidence` -> Settings -> Object
   lifecycle rules -> add rule, all objects, delete after 180 days.

3. Set the ticket secret (at least 32 characters; uploads return 503 until it is set):

   ```bash
   openssl rand -base64 48 | pnpm exec wrangler secret put UPLOAD_TICKET_SECRET
   ```

   Rotating it invalidates only in-flight 5-minute tickets.

4. DNS and route: `wrangler.toml` declares the route
   `evidence.matrix-os.com/*` on zone `matrix-os.com`. Either let the first
   deploy attach it, or add a proxied (orange-cloud) DNS record for
   `evidence` (for example `AAAA evidence 100::`) so the route receives
   traffic. Alternatively replace `routes` with
   `routes = [{ pattern = "evidence.matrix-os.com", custom_domain = true }]`
   and Cloudflare creates the DNS record and certificate.

5. Deploy:

   ```bash
   pnpm exec wrangler deploy --dry-run   # bindings check
   pnpm exec wrangler deploy
   ```

6. Verify: `curl -sI https://evidence.matrix-os.com/` returns 404, and
   `scripts/pr-evidence upload <pr> shot.png --no-comment` prints a working URL.

## Development

```bash
pnpm exec vitest run tests/pr-evidence-worker   # from the repo root
pnpm --filter @matrix-os/pr-evidence-worker typecheck
```
