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

### Why upload through the Worker

Uploads go through the Worker's R2 binding, not R2 S3 presigned URLs, so no R2
S3 access keys exist. The ticket (HMAC-SHA256 over key, type, size, GitHub
login, and a 5-minute expiry) is returned inside `uploadUrl` as `?t=<ticket>`
(a `Bearer` header also works). The Worker checks type and exact length in
code and writes with `If-None-Match: *`, so a key can be written only once.
Bodies are capped at 50 MB, below the Workers request-size limit on every plan.

### Rate limiting

A fixed one-hour window per GitHub login, counted when tickets are issued,
held in a bounded in-memory map (1,000 logins, TTL eviction). It is per Worker
isolate, so it bounds bursts rather than enforcing a global quota. The real
gate is GitHub write access; a Durable Object counter can replace this if
abuse appears. The GitHub allow decision is cached by SHA-256 of the token for
at most 5 minutes (bounded to 500 entries); denials are never cached.

## Owner setup

CI never deploys this Worker. Account `63a1787d41e5df7aee344eab876fffe8` owns
the `matrix-os.com` zone and is pinned in `wrangler.toml`.

1. Bucket `matrix-pr-evidence` (already created) with a 180-day expiry rule
   (already set as `expire-180d`). To recreate:

   ```bash
   cd packages/pr-evidence-worker
   pnpm exec wrangler r2 bucket create matrix-pr-evidence
   pnpm exec wrangler r2 bucket lifecycle add matrix-pr-evidence expire-180d --expire-days 180 --force
   ```

2. Ticket secret (at least 32 characters; uploads return 503 until set):

   ```bash
   openssl rand -base64 48 | pnpm exec wrangler secret put UPLOAD_TICKET_SECRET
   ```

   Rotating it invalidates only in-flight 5-minute tickets.

3. Deploy. The `evidence.matrix-os.com` custom domain route makes Cloudflare
   create the DNS record and certificate:

   ```bash
   cd packages/pr-evidence-worker
   pnpm exec wrangler deploy --dry-run   # bindings check
   pnpm exec wrangler deploy
   ```

4. Verify: `curl -sI https://evidence.matrix-os.com/` returns 404, and
   `scripts/pr-evidence upload <pr> shot.png --no-comment` prints a working URL.

## Development

```bash
pnpm exec vitest run tests/pr-evidence-worker   # from the repo root
pnpm --filter @matrix-os/pr-evidence-worker typecheck
```
