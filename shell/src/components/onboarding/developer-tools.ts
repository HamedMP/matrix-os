export type DeveloperToolId = "codex" | "claude-code" | "opencode" | "pi";

export const developerToolOptions: Array<{ id: DeveloperToolId; label: string; logoPath: string }> = [
  { id: "codex", label: "Codex", logoPath: "/agents/codex.svg" },
  { id: "claude-code", label: "Claude Code", logoPath: "/agents/claude-code.svg" },
  { id: "opencode", label: "OpenCode", logoPath: "/agents/opencode.svg" },
  { id: "pi", label: "Pi", logoPath: "/agents/pi.svg" },
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
