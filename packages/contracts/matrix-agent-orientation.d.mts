export function buildMatrixAgentOrientation(input: {
  surface: "kernel" | "claude" | "codex";
  customMcpScope?: "none" | "call" | "discovery";
}): string;
