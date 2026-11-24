export const MATRIX_CORE_MCP_DISCOVERY_POINTER: string;
export const MATRIX_SHARED_BROWSER_LAUNCH_POINTER: string;

export function buildMatrixAgentOrientation(input: {
  surface: "kernel" | "claude" | "codex";
  customMcpScope?: "none" | "call" | "discovery";
}): string;
