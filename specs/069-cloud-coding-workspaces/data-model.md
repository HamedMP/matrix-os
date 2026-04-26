# Data Model: Cloud Coding Workspaces

All records are user-owned Matrix data. Initial storage is file-backed JSON under the user's Matrix home. Implementations may later migrate storage, but export/delete semantics and the API contract must preserve these entities.

## Project

Path: `~/projects/{slug}/config.json`

```ts
interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  remote?: string;
  localPath: string;
  defaultBranch?: string;
  addedAt: string;
  updatedAt: string;
  ownerScope: { type: "user" | "org"; id: string };
  github?: {
    owner: string;
    repo: string;
    htmlUrl: string;
    authState: "unknown" | "ok" | "required" | "rate_limited" | "error";
    lastPrRefreshAt?: string;
    lastBranchRefreshAt?: string;
  };
  preferences?: {
    taskView?: "board" | "list";
  };
}
```

## Task

Path: `~/projects/{slug}/tasks/{taskId}.json`

```ts
interface TaskRecord {
  id: string;
  projectSlug: string;
  title: string;
  description?: string;
  status: "todo" | "running" | "waiting" | "blocked" | "complete" | "archived";
  priority: "low" | "normal" | "high" | "urgent";
  order: number;
  parentTaskId?: string;
  dueAt?: string;
  linkedSessionId?: string;
  linkedWorktreeId?: string;
  previewIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

## Worktree

Derived from git plus Matrix metadata stored under `~/projects/{slug}/worktrees/{worktreeId}/.matrix/worktree.json`.

```ts
interface WorktreeRecord {
  id: string;
  projectSlug: string;
  path: string;
  sourceBranch: string;
  currentBranch: string;
  pr?: {
    number: number;
    title?: string;
    headRef?: string;
    baseRef?: string;
  };
  dirtyState: "unknown" | "clean" | "dirty";
  dirtyCount?: number;
  createdAt: string;
  lastGitRefreshAt?: string;
}
```

## Worktree Lease

Path: `~/projects/{slug}/worktrees/{worktreeId}/.matrix/lease.json`

```ts
interface WorktreeLease {
  id: string;
  projectSlug: string;
  worktreeId: string;
  holderType: "session" | "review";
  holderId: string;
  mode: "write";
  acquiredAt: string;
  heartbeatAt: string;
  recoverableAfter?: string;
}
```

## Workspace Session

Path: `~/system/sessions/{sessionId}.json`

```ts
interface WorkspaceSession {
  id: string;
  kind: "shell" | "agent";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  agent?: "claude" | "codex" | "opencode" | "pi";
  runtime: {
    type: "zellij" | "tmux" | "pty";
    status: "starting" | "running" | "idle" | "waiting" | "exited" | "failed" | "degraded";
    zellijSession?: string;
    zellijLayoutPath?: string;
    tmuxSession?: string;
    fallbackReason?: string;
  };
  terminalSessionId: string;
  transcriptPath: string;
  attachedClients: number;
  writeMode: "owner" | "takeover" | "closed";
  ownerId: string;
  startedAt: string;
  lastActivityAt: string;
  exitedAt?: string;
  exitCode?: number;
}
```

## Review Loop

Path: `~/system/reviews/{reviewId}.json`

```ts
interface ReviewLoopRecord {
  id: string;
  projectSlug: string;
  worktreeId: string;
  pr: number;
  status:
    | "queued"
    | "reviewing"
    | "implementing"
    | "verifying"
    | "converged"
    | "stalled"
    | "failed"
    | "failed_parse"
    | "stopped"
    | "approved";
  round: number;
  maxRounds: number;
  reviewer: "claude" | "codex" | "opencode" | "pi";
  implementer: "claude" | "codex" | "opencode" | "pi";
  convergenceGate: "findings_only" | "findings_and_verify";
  verificationCommands: string[];
  activeSessionId?: string;
  leaseId?: string;
  rounds: ReviewRoundRecord[];
  createdAt: string;
  updatedAt: string;
}

interface ReviewRoundRecord {
  round: number;
  phase: "review" | "implement" | "verify";
  sessionId?: string;
  findingsPath?: string;
  controlPath?: string;
  parserStatus?: "not_started" | "success" | "failed";
  findingsCount?: number;
  severityCounts?: { high: number; medium: number; low: number };
  implementerCommit?: string;
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
}
```

## Preview

Path: `~/projects/{slug}/previews/{previewId}.json`

```ts
interface PreviewRecord {
  id: string;
  projectSlug: string;
  taskId?: string;
  sessionId?: string;
  label: string;
  url: string;
  lastStatus: "unknown" | "ok" | "failed";
  displayPreference: "panel" | "external";
  createdAt: string;
  updatedAt: string;
}
```

## Activity Event

Bounded records used for workspace/TUI/CLI updates.

```ts
interface ActivityEvent {
  id: string;
  scope: { projectSlug?: string; taskId?: string; sessionId?: string; reviewId?: string };
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
```
