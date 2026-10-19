# Transfer and organize a project

## Prepare a working-tree snapshot

Resolve `scripts/snapshot.mjs` relative to this installed skill, independently of
the source project's cwd:

```bash
node /absolute/skill/scripts/snapshot.mjs /absolute/project --brief /absolute/brief.md
```

This performs no network operation. It returns JSON with a private temporary
directory, manifest, ordered parts, compressed SHA-256, unique `projectPath`, and
file counts. Read the manifest's `files`, `skipped`, `git`, and `limitations`
before transferring. Never blindly archive a directory with `tar` from the source.

Git projects include tracked and nonignored untracked regular files with their
current contents. Deleted files stay deleted because extraction uses an empty
destination. Non-Git folders are also supported. Executable bits survive.
Credentials, agent/auth state, ignored files, build/dependency directories, and
symlinks are excluded. Directory counts/bytes/depth are bounded. Empty folders
are not captured. Exclusions are filename-based and cannot find secrets pasted
into ordinary source files; inspect the selected scope accordingly.

Git objects, unpushed commits, staged/unstaged distinctions, worktrees, remotes,
and submodule repositories are not restored. Read Git status and any submodule
inventory. If full Git preservation is requested, keep that step outstanding
until a separately reviewed Git bundle/patch or remote-backed transfer preserves
the required commits/index. Never call a fresh `git init` equivalent to that.

## Upload and verify

Use one explicit CLI profile consistently. For each returned part, upload to the
unique transfer directory with an exact filename, without `--force`:

```bash
matrix upload /absolute/part-0000 .matrix-move/<id>/part-0000 --profile <profile> --json
```

Each part is at most 8 MiB. If a retry finds an existing part, compare its bytes or
hash before reusing it. Do not overwrite unknown files. After all parts succeed,
run a bounded command on the same Matrix computer, using `run_command` argv or
`matrix run --project main --profile <profile> -- <argv...>`:

1. Concatenate only the recorded ordered part names into a temporary archive.
2. Check the archive SHA-256 against the captured result before extraction.
3. Reserve the returned `projectPath` exclusively. Stop on an existing path;
   never merge an uncertain or partially extracted directory into a project.
4. Extract this locally generated, checksum-verified archive there. Do not
   extract arbitrary uploaded archives or follow symlinks.
5. Read `.matrix-move/manifest.json`; check every destination regular file's
   byte count/SHA-256 and executable mode. Verify the brief when present.
6. Delete exact remote parts and temporary archive after verification. On
   failure, retain an identified partial destination for diagnosis and report
   it; never call it complete or register it yet.

Pass user paths as argv values. If using a small remote script, pass the ID,
destination, hash, and ordered part list as separate arguments; do not interpolate
untrusted filenames into shell source. Matrix-home paths are relative, without
`~` or local-machine absolute prefixes. Do not read remote service credentials.

## Register and attach

In the authenticated Matrix UI on that computer, use **Add project → Existing
folder**, select the verified destination, keep it personal/private, and verify
the project appears. Use **Move to project** on each imported canonical Chat.
Do not edit `system/projects`, database rows, renderer stores, or internal runtime
files directly. Registration and Chat association must use product authority.

Existing API equivalents, for a client with an established authenticated runtime
transport, are:

| Operation | Contract |
| --- | --- |
| Register folder | `POST /api/projects` with `{mode:"folder",name,path,clientRequestId}`; reuse a stable `req_...` request ID on retries |
| Read project | `GET /api/projects/:slug`; retain the server's slug and actual folder path |
| Read private Chat | `GET /api/chats/:chatId`; use the current revision |
| Attach Chat | `PATCH /api/chats/:chatId/project` with `{baseRevision,projectId}` |

Owner identity comes from the authenticated principal. A stale revision requires
read/reconciliation, not blind mutation retry. Private Chats must not inherit an
organization grant accidentally. The organization-drive `drive-project` endpoint
is a different association and does not register a filesystem project.

The CLI has no `projects import` or `chats move` command, and hosted MCP has no
project mutation tool. Use the UI when no authenticated client transport exists;
do not invent commands or scrape auth stores to make the request.
