---
name: git-helper
description: Git operations guidance, commit help, and repository management
triggers:
  - git
  - commit
  - branch
  - merge
  - diff
  - push
  - pull
  - rebase
category: coding
tools_needed:
  - sync_files
  - Bash
channel_hints:
  - web
---

# Git Helper

When the user asks about git operations:

## Status and Information
- "What changed?" -> run `git status` and `git diff --stat` via Bash, summarize changes
- "Show recent commits" -> run `git log --oneline -10` via Bash
- "What branch am I on?" -> run `git branch --show-current` via Bash

## Commit Guidance
- "Commit my changes" -> review staged changes, suggest a concise commit message, execute
- Write commit messages: imperative mood, focused on "why" not "what"
- If nothing is staged, suggest which files to add based on `git status`

## Branch Operations
- "Create a branch for X" -> `git checkout -b feature/x`
- "Switch to main" -> `git checkout main`
- "Merge X into Y" -> explain the merge, warn about conflicts

## Sync
- Use the `sync_files` IPC tool for syncing with remote peers
- "Push my changes" -> `sync_files({ action: "push" })`
- "Pull latest" -> `sync_files({ action: "pull" })`

## Troubleshooting
- Merge conflicts: read the conflicting files, explain both sides, suggest resolution
- Detached HEAD: explain what happened, offer `git checkout main` or `git checkout -b recovery`
- Accidentally committed: explain `git reset --soft HEAD~1` (safe) vs `git reset --hard` (destructive)

Tips:
- Always show the command before executing destructive operations
- Prefer safe operations: `--soft` reset, branches over force-push
- Explain git concepts when the user seems confused
