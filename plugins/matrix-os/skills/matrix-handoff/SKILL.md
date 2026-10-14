---
name: matrix-handoff
description: Move the current repository and coding task to the user's Matrix computer as a project Chat, creating the Matrix project if it is missing. Use when the user asks to continue on Matrix, hand off or migrate local work to Matrix, or move this Codex/Claude Code conversation to their Matrix computer.
version: 3.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
---

# Matrix handoff

`matrix handoff` moves the current Git repository and task to the user's
Matrix computer. It runs in two steps: a preview that changes nothing, then the
approved handoff. It:

- finds the matching Matrix project by its GitHub repository, or creates it
  (cloning it from GitHub, or uploading it if Matrix cannot clone it);
- carries over the branch, commits that are not on origin, and uncommitted
  changes, including untracked files;
- opens the branch's worktree;
- starts a new Matrix Chat bound to that project, running the chosen agent,
  with your brief as the first message.

It never pushes to GitHub and never uploads `.env` files, keys, or credentials.

## Readiness

1. `matrix handoff --help` must work. If it does not, tell the user to update
   the CLI with `pnpm add -g @finnaai/matrix`, and stop.
2. `matrix whoami` must name the intended owner. If it does not, tell the user
   to run `matrix login`, and stop. Never pass tokens in arguments.

## Workflow

1. Write a continuation brief to a new temporary Markdown file outside the
   repository. Include:
   - the user's goal;
   - what is done and the decisions made;
   - current failures or blockers;
   - the exact next steps;
   - commands and tests already run.

   Never copy credentials, tokens, `.env` values, or unrelated conversation
   content into it.
2. Choose the agent: whatever the user asked for, otherwise the agent running
   this skill (`claude` for Claude Code, `codex` for Codex).
3. Preview from inside the repository. Keep stdin redirected from `/dev/null`,
   so the CLI prints the approval command instead of asking a y/N question:

   ```bash
   matrix handoff --agent claude --brief /tmp/matrix-handoff-brief.md </dev/null
   ```

   Pass on any options the user asked for: `--history none`, `--title`,
   `--model`, `--permission`, `--profile`.
4. Show the preview to the user, in particular:
   - the project action;
   - the branch;
   - the counts of commits and uncommitted changes;
   - the withheld files;
   - the transcript path;
   - the agent.

   If a transcript is listed, say that the raw transcript can contain anything
   pasted into this session, and that it is imported as a private Matrix Chat.
5. Ask for explicit approval. Never treat the original request as approval.
6. After approval, run the exact command the preview printed, ending in
   `--approve <token>`. If it reports that the scope changed, preview again and
   ask again.
7. Report the Chat link, the project and the branch. If the result says it
   landed on a `handoff/...` side branch, explain that the Matrix copy of the
   branch had other work, and that nothing was overwritten.
8. Delete the temporary brief.

## Failures

- **The agent is not signed in on Matrix:** the preview prints the login
  command. Tell the user to run it in a Matrix terminal (for example
  `matrix run -it -- claude`), then retry.
- **GitHub is not connected on Matrix:** the handoff uploads the repository
  instead. To clone from GitHub in future, the user can run
  `matrix run -it -- gh auth login`.
- **Any other error:** do not work around it by copying files manually. Report
  the message. Re-running is safe, because every step can be repeated.

The handoff does not resume the original provider session. The Matrix Chat
starts fresh from the brief, the repository state and, optionally, the imported
transcript.
