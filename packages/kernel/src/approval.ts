export interface ToolPattern {
  tool: string;
  argPatterns?: Record<string, string>;
}

export interface ApprovalPolicy {
  enabled: boolean;
  requireApproval: ToolPattern[];
  autoApprove: string[];
  timeout: number;
}

const DESTRUCTIVE_BASH_PATTERNS = /\b(rm\s+-r|rm\s+-f|rm\s+-rf|rmdir|kill\s+-9|kill\s+-KILL|DROP\s+TABLE|DROP\s+DATABASE|truncate\s+table|mkfs\.|dd\s+if=|>\s*\/dev\/sd)/i;

const SYSTEM_PATH_PATTERN = /\/system\//;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  enabled: true,
  requireApproval: [
    { tool: "Bash", argPatterns: { command: DESTRUCTIVE_BASH_PATTERNS.source } },
    { tool: "Write", argPatterns: { file_path: SYSTEM_PATH_PATTERN.source } },
    { tool: "Edit", argPatterns: { file_path: SYSTEM_PATH_PATTERN.source } },
  ],
  autoApprove: [
    "Read",
    "Glob",
    "Grep",
    "mcp__matrix-os-ipc__list_tasks",
    "mcp__matrix-os-ipc__read_state",
    "mcp__matrix-os-ipc__load_skill",
    "mcp__matrix-os-ipc__read_messages",
    "mcp__matrix-os-ipc__search_conversations",
  ],
  timeout: 30000,
};

export function shouldRequireApproval(
  toolName: string,
  args: unknown,
  policy: ApprovalPolicy,
): boolean {
  if (!policy.enabled) return false;

  const toolArgs = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  for (const pattern of policy.requireApproval) {
    if (pattern.tool !== toolName) continue;

    if (!pattern.argPatterns) return true;

    for (const [key, regex] of Object.entries(pattern.argPatterns)) {
      const value = String(toolArgs[key] ?? "");
      if (new RegExp(regex, "i").test(value)) {
        return true;
      }
    }
  }

  return false;
}
