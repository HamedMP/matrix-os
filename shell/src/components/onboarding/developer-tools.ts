export type DeveloperToolId = "codex" | "claude-code" | "opencode" | "pi";

// Same brand logos the terminal's new-session menu uses (/agent-logos/*.png).
// These are light-on-dark, so the installs chip renders them on a dark tile.
export const developerToolOptions: Array<{ id: DeveloperToolId; label: string; logoPath: string }> = [
  { id: "codex", label: "Codex", logoPath: "/agent-logos/codex.png" },
  { id: "claude-code", label: "Claude Code", logoPath: "/agent-logos/claude-code.png" },
  { id: "opencode", label: "OpenCode", logoPath: "/agent-logos/opencode-white.png" },
  { id: "pi", label: "Pi", logoPath: "/agent-logos/pi-coding-agent.png" },
];

export const defaultDeveloperTools: DeveloperToolId[] = developerToolOptions.map((tool) => tool.id);

export function nextDeveloperToolsSelection(
  selectedTools: readonly DeveloperToolId[],
  tool: DeveloperToolId,
): DeveloperToolId[] {
  const selectedToolSet = new Set(selectedTools);
  const removeTool = selectedToolSet.has(tool);
  const nextTools: DeveloperToolId[] = [];
  for (const option of developerToolOptions) {
    if (removeTool && option.id === tool) continue;
    if (option.id === tool || selectedToolSet.has(option.id)) {
      nextTools.push(option.id);
    }
  }
  return nextTools;
}
