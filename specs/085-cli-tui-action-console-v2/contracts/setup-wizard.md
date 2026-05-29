# Contract: Setup Wizard

## Purpose

Guide agent setup and local migration without copying secrets or surprising the user.

## Steps

1. Choose coding agents
2. Choose whether to migrate local non-secret configuration
3. Preview migration candidates and skipped items
4. Confirm write plan
5. Apply selected setup steps
6. Show done, partial, skipped, cancelled, or safe failure state
7. Offer terminal handoff or next action

## Agent Defaults

- Codex: selected by default
- Claude: available but unchecked by default

## Migration Safety

Migration must skip secrets, tokens, credentials, symlinks, oversized files, unsupported formats, and unreadable files. Writes require preview and confirmation.
