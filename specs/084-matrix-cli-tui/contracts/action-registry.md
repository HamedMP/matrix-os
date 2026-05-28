# Contract: TUI Action Registry

## Purpose

The TUI action registry is the canonical catalog for palette commands, keyboard shortcuts, help, dangerous-action confirmations, and coverage tests.

## Entry Shape

```ts
type TuiAction = {
  id: string;
  title: string;
  group: string;
  aliases: string[];
  intents: string[];
  shortcut?: string;
  directCommand?: string;
  requiresContext?: string[];
  danger: "none" | "confirm" | "exact-phrase";
  confirmationPhrase?: string;
  handler: "view" | "flow" | "direct-command" | "external-attach";
};
```

## Required Groups

- Account and Profile
- Instance
- Status and Doctor
- File Sync and Peers
- Shell and Remote Run
- Projects and Worktrees
- Sessions and Agents
- Reviews
- Tasks
- Previews
- Workspace Data
- Utility

## Invariants

- Every current command family has at least one action.
- Every destructive action has `danger` other than `none`.
- Workspace data deletion uses `exact-phrase` with `delete project workspace data`.
- Search matches title, group, aliases, intents, and known object labels.
- Direct command equivalents remain descriptive; the TUI handler is responsible for safe validation and feedback.
