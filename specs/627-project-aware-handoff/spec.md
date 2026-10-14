# Project-aware Matrix handoff

Linear: [ENG-302](https://linear.app/matrix-os/issue/ENG-302/project-aware-matrix-handoff-move-local-codexclaude-tasks-into-a)

## Goal

Move a local Codex or Claude Code task to the owner's Matrix computer with one
command, `matrix handoff`. It lands as a new Matrix Chat bound to the matching
Matrix project and worktree, with the local branch, commits and uncommitted work
already in place. If the project does not exist on Matrix yet, the handoff
creates it first.

## Problem

The earlier handoff script (`.agents/skills/matrix-handoff`) uploads a tarball
without `.git` to a new `~/projects/<name>-handoff-<stamp>` directory on every run.
It never reuses a project, worktree or branch, and it starts a terminal session
instead of a Chat. Its last step calls `matrix shell new <name> --cmd …` and
`matrix shell attach`, but the current CLI does not have those options, so the
handoff fails after the upload. The skill also lives only in this repository, so
users on their own laptops do not have it.

## Flow

1. **Inspect the local repository.** Read the root, branch (or a synthetic
   `handoff/<sha>` name when HEAD is detached), HEAD, the `origin` remote, and the
   root commit.
2. **Snapshot local work without changing it.** Use a temporary index to record
   tracked and untracked, non-ignored files as a snapshot commit whose parent is
   HEAD. Files the secret filter rejects (`.env*`, keys, credential files) keep
   their HEAD version, or are left out entirely if they are untracked. The user's
   index, working tree and refs are not changed.
3. **Bundle.** A git bundle carries the branch and the snapshot under
   `refs/matrix-handoff/*`. When the Matrix project already exists, the bundle
   leaves out commits that the local `origin/*` refs already contain. The remote
   side checks that this smaller bundle applies, and the client falls back to a
   full bundle if it does not.
4. **Find the Matrix project.** Match by GitHub `owner/repo` (case-insensitive,
   https or ssh form). Otherwise match by the deterministic slug
   `<repo-name>-<root-commit-7>`.
5. **Create the project if it is missing.**
   - A GitHub remote uses `POST /api/projects {mode:"github"}`.
   - If that returns `github_auth_required`, or the repo has no GitHub remote,
     the handoff clones the bundle into `~/projects/<slug>`, restores the real
     `origin` URL, and registers it with `{mode:"folder"}`.
   - Every create carries a deterministic `clientRequestId`, so a retry returns
     the same project.
6. **Branch and worktree.**
   - The bundle is fetched into `refs/matrix-handoff/<id>/head`, never directly
     into a branch.
   - If the branch does not exist on Matrix, it is created there.
   - If it exists and is an ancestor of the incoming head, it is fast-forwarded.
     This is done in its worktree when it is checked out and clean.
   - If it has diverged, or its worktree has uncommitted changes, nothing is
     overwritten. The work lands on a new branch `handoff/<branch>-<stamp>`, and
     the preview and result say so.
   - The worktree comes from `POST /api/projects/:slug/worktrees {branch}`. If the
     branch is the one checked out in the project's main checkout, the Chat runs
     at the project root.
7. **Apply uncommitted work.** In a clean target checkout, apply
   `git diff --binary HEAD <snapshot>`. Modified, added and deleted files then
   appear as uncommitted changes, the same as on the local machine.
8. **Optional transcript.** The current session's transcript is found through
   the existing local chat discovery (`--project <root>`) and imported as a
   private Chat through the existing local import pipeline. It does not resume
   the provider session.
9. **Chat.**
   - Read `GET /api/chat-providers` and pick `codex_default` or
     `claude_code_default`. It must be `available`; otherwise the preview stops
     before uploading anything and shows the login command.
   - Create the Chat with `POST /api/chats {projectId}`.
   - Send the brief as the first turn with
     `executionRoot {kind:"worktree"|"project"}`. The selection uses the
     provider's default model and options, `interactionMode` `default`, and
     `permissionMode` `supervised`.
10. **Open.** Print `<gateway>/?launch=__chat__&chat=<chatId>`. The shell reads
    the `chat` parameter, opens Chat and selects that conversation.

## Consent and safety

- Running without approval only previews. The preview lists:
  - the project action (reuse or create, and how);
  - the branch outcome;
  - the commit count;
  - changed files, and files withheld by the secret filter;
  - the transcript path;
  - the agent and its readiness;
  - an approval token.
- `--approve <token>` runs exactly the previewed scope. The token is a hash of
  the plan and the bundle bytes. In an interactive terminal, the CLI can ask
  instead of requiring the token.
- Nothing is pushed to any git remote. Credentials are never uploaded; the
  agent signs in again inside Matrix.
- Remote scripts are built only from validated identifiers (slug, branch,
  upload id) and passed as `sh -c` arguments. Each script stays under 16 KB.
- Staging lives in `~/data/matrix-handoff/<id>/` and is deleted when the
  handoff succeeds or fails.
- Remote branches are never rewritten. Divergence always produces a new branch.

## Distribution

- The CLI command ships in `@finnaai/matrix`.
- The `matrix-handoff` skill becomes a thin wrapper. It writes the brief, runs
  `matrix handoff`, shows the preview and approves it. It is published in
  `plugins/matrix-os`, so Codex and Claude Code on any laptop can install it
  without this repository.
- The old script stays as a compatibility shim that forwards to the CLI.

## Done when

- Running `matrix handoff --agent claude --brief brief.md` from a local clone:
  - reuses the matching Matrix project, or creates it;
  - opens or creates the branch worktree;
  - carries over unpushed commits and uncommitted edits;
  - creates a project-bound Chat that has started its first turn;
  - prints a link that opens that Chat.
- A second run on the same branch reuses the project and worktree. If the
  remote worktree was changed in the meantime, the second run lands on a
  side branch instead of overwriting it.
- Unit tests cover:
  - git inspection, snapshot, bundling and secret withholding (against real
    temporary repositories);
  - project matching and the plan and approval token;
  - remote script generation;
  - the gateway client, against a fake gateway;
  - parsing the shell deep link.
