# Data Model: Matrix CLI TUI

## CLI Entrypoint

- **Fields**: binary alias, raw args, parsed command, stdout/stderr interactivity, json/no-color flags, resolved launch mode.
- **Relationships**: selects either direct command execution or TUI runtime.
- **Validation**: direct commands always win over default TUI except explicit `tui`; non-TTY disables interactive launch.

## TUI Runtime State

- **Fields**: active view, selected item, palette query, modal state, pending confirmation, refresh status, safe error, terminal dimensions, color mode.
- **Relationships**: reads status snapshot and action registry; opens views and flows.
- **Validation**: state must stay serializable except live renderer handles; narrow terminals hide decorative content first.

## Action Registry Entry

- **Fields**: id, title, group, aliases, intent phrases, shortcut, required context, danger level, confirmation policy, direct command equivalent, handler kind.
- **Relationships**: powers command palette, help, keyboard shortcuts, coverage tests, and flow routing.
- **Validation**: every command family in the spec must have at least one registry entry; dangerous entries require confirmation policy.

## Status Snapshot

- **Fields**: profile, auth, identity, instance, gateway, platform, sync, peers, sessions, projects, agents, reviews, blocking actions, refreshedAt.
- **Relationships**: displayed on home, doctor/status views, and first-run flow.
- **Validation**: each subsystem can be healthy, degraded, offline, unknown, or unauthenticated without failing the whole snapshot.

## Profile

- **Fields**: name, active flag, platform URL, gateway URL, source, dev flag.
- **Relationships**: owns auth lookup and all gateway/client requests.
- **Validation**: profile names and URLs must be validated before editing or use.

## Auth State

- **Fields**: authenticated, expired, rejected, identity handle, user id, recovery action.
- **Relationships**: belongs to a profile and gates mutating actions.
- **Validation**: missing/expired/rejected tokens produce recoverable TUI states.

## Matrix Instance

- **Fields**: handle/name, gateway URL, platform URL, health, logs availability, restart eligibility, last checked.
- **Relationships**: active runtime for profile-scoped commands.
- **Validation**: restart is destructive and requires confirmation.

## Sync State

- **Fields**: daemon state, sync path, gateway subtree, pause/running state, peer count, manifest version, file count, last sync time.
- **Relationships**: displayed on home and sync view; controlled through daemon IPC and sync config.
- **Validation**: daemon errors, stale sockets, and oversized/invalid responses become safe degraded states.

## Shell Session

- **Fields**: name, status, cwd, created/updated time, tabs, panes, layouts, attach state, native attach command.
- **Relationships**: backed by zellij runtime; managed by shell/session views.
- **Validation**: names, cwd, layout, pane ids, and tab indexes must be validated; removal requires confirmation.

## Coding Session

- **Fields**: id, kind, status, project slug, worktree id, task id, pull request, agent, runtime, timeline, write mode, terminal session id.
- **Relationships**: links projects, tasks, agents, reviews, and shell runtime.
- **Validation**: observe/takeover/write/kill actions must validate session id and current capability.

## Project

- **Fields**: slug, display name, repository identity, branches, pull requests, worktrees, tasks, previews, sessions, reviews, recent activity.
- **Relationships**: parent for coding work and workspace data.
- **Validation**: project slugs and repository URLs must be validated; removal requires confirmation.

## Worktree

- **Fields**: id, project slug, branch or pull request, path, dirty state, active sessions, created/updated time.
- **Relationships**: scoped to project and used by sessions/reviews.
- **Validation**: dirty removal requires explicit dirty-delete confirmation.

## Agent

- **Fields**: name, provider/tool identity, availability, sandbox status, attention state.
- **Relationships**: selected for coding sessions and review flows.
- **Validation**: unavailable agents are visible but not startable without recovery guidance.

## Review

- **Fields**: id, project slug, worktree id, pull request, status, round, findings summary, next action.
- **Relationships**: links project/worktree/agent activity.
- **Validation**: approve/next/stop require current review state to allow action.

## Task

- **Fields**: id, project slug, title, priority, status, archived/deleted state, linked sessions.
- **Relationships**: can start coding sessions and appear in project detail.
- **Validation**: delete requires confirmation; archive does not silently remove linked history.

## Preview

- **Fields**: id, project slug, task id, session id, label, URL, last status, updated time.
- **Relationships**: attached to project/task/session work.
- **Validation**: URLs must be validated before add/open/copy actions; removal requires confirmation.

## Workspace Event

- **Fields**: id, type, timestamp, scope, status, summary, payload summary.
- **Relationships**: filterable by project, task, session, review, preview, and status.
- **Validation**: event display must avoid raw provider/server error leakage.

## TUI Preference

- **Fields**: theme, no-color preference, default view, shortcut help visibility, mascot visibility, native writeback choices.
- **Relationships**: belongs to the local owner and influences TUI rendering only.
- **Validation**: must be owner-readable, non-secret, and safe to recover from malformed content.
