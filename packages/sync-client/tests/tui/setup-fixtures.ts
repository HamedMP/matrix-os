export const setupAgentFixtures = [
  { id: "codex", label: "Codex", selected: true },
  { id: "claude", label: "Claude", selected: false },
] as const;

export const setupMigrationSourceFixtures = [
  {
    id: "codex-config",
    agentId: "codex",
    label: "Codex config",
    sourcePath: "~/.codex",
    eligible: true,
    selected: true,
    fileCount: 3,
    totalBytes: 4096,
  },
  {
    id: "claude-config",
    agentId: "claude",
    label: "Claude config",
    sourcePath: "~/.claude",
    eligible: false,
    selected: false,
    skippedReason: "not found",
    fileCount: 0,
    totalBytes: 0,
  },
] as const;

export const setupResultFixtures = [
  { id: "agents", label: "Configured selected agents", status: "completed" },
  { id: "migration", label: "Imported selected local config", status: "skipped" },
  { id: "terminal", label: "Opened setup terminal", status: "completed" },
] as const;
