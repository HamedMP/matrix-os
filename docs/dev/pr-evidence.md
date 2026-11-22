# PR Evidence Uploads

How engineers and agents attach screenshots and recordings to a PR. Spec:
`specs/2708-pr-evidence-uploads/`. Worker: `packages/pr-evidence-worker/`.

## What it is

- `scripts/pr-evidence` uploads captures to `evidence.matrix-os.com`, a
  Cloudflare Worker backed by a private R2 bucket.
- Files expire after 180 days.
- Each file gets an unguessable URL. Anyone with the link can view it;
  nothing is listable.
- Never commit captures to the repo, including `docs/pr-evidence/`.

## Prerequisites

`gh auth login` with write access to `HamedMP/matrix-os`. Nothing else: no
Cloudflare account, keys, or extra installs.

## Usage

```bash
scripts/pr-evidence upload <pr> <files...> [--title "..."] [--commit <sha>] [--no-comment]

# Two surfaces, one comment:
scripts/pr-evidence upload 3551 web-desktop.png electron-desktop.png journey.mp4 \
  --title "Electron Desktop · Herdr sessions"
```

| Option | Effect |
| --- | --- |
| `--title` | Comment heading. Name the surfaces shown. |
| `--commit <sha>` | Commit/build tested. Defaults to the PR head. |
| `--no-comment` | Print the markdown instead of commenting. |

- Types: png, jpeg, webp, gif images; mp4, webm, mov video.
- Limits: 50 MB per file, 10 files per run, 60 files per GitHub login per hour.

## What the comment looks like

A `### PR evidence: <title>` heading, the tested commit, images inline, and
videos as links on their own line (GitHub only plays its own uploads inline).
Paste the same links into the Slack `#tech` evidence post.

## Labeling and redaction

- Label every capture with its exact surface: Web Canvas, Web Desktop,
  Electron Desktop, Web Mobile, or Native Mobile. Use the file name or
  `--title`. One surface never stands in for another.
- Upload captures of the commit/build named in the comment. Pass `--commit`
  when you tested something other than the PR head.
- Links are public to anyone who has them. Redact credentials, tokens,
  customer data, and private emails before uploading.

## Agents

- After capturing, run the same command with the PR number.
- If `gh` is not authenticated or the upload fails, keep the files outside
  the repo and report their absolute paths to the developer. Do not retry in a
  loop and do not commit them.

## Troubleshooting

| Response | Meaning | Fix |
| --- | --- | --- |
| `unauthorized` (401) | `gh` not logged in or token expired | `gh auth login` |
| `forbidden` (403) | No write access to the repo | Ask a maintainer for access |
| `invalid_ticket` (403) | Upload ticket expired or tampered | Rerun the command |
| `pull_request_not_found` (404) | Wrong PR number | Check the number |
| `invalid_request` (400), `content_type_mismatch` (415) | Unsupported type or over 50 MB | Convert or trim the file |
| `already_uploaded` (409) | Ticket reused | Rerun; each run mints new keys |
| `rate_limited` (429) | Over 60 files this hour | Wait, or upload fewer files |
| `authorization_unavailable` (503) | GitHub or the Worker is unavailable | Retry later |

## Local development

`MATRIX_PR_EVIDENCE_URL=http://localhost:8787` points the CLI at a local
Worker. See `packages/pr-evidence-worker/README.md` for `wrangler dev` setup.
