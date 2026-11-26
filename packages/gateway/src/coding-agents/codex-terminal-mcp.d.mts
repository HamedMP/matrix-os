import type { z } from "zod/v4";
export const CODEX_TERMINAL_MCP_TOOLS: string[];
export const CODEX_TERMINAL_MCP_INSTRUCTIONS: string;
export const CodexTerminalMcpLeaseSchema: z.ZodObject<{
  attemptId: z.ZodString;
  token: z.ZodString;
  gatewayPort: z.ZodNumber;
  launcher: z.ZodLiteral<"/opt/matrix/bin/matrix-integrations-mcp">;
}>;
export const CodexTerminalMcpBindSchema: z.ZodObject<{
  attemptId: z.ZodString;
  token: z.ZodString;
  gatewayPort: z.ZodNumber;
  launcher: z.ZodLiteral<"/opt/matrix/bin/matrix-integrations-mcp">;
  type: z.ZodLiteral<"matrix_mcp_bind">;
  clientRequestId: z.ZodString;
}>;
export const CodexTerminalMcpStartSchema: z.ZodObject<{
  type: z.ZodLiteral<"matrix_mcp_start">;
  attemptId: z.ZodString;
  clientRequestId: z.ZodString;
}>;
export function codexTerminalMcpThreadConfig(
  lease?: z.infer<typeof CodexTerminalMcpLeaseSchema>,
): Record<string, Record<string, unknown>>;
export function codexTerminalMcpChildEnvironment(
  environment: NodeJS.ProcessEnv,
  lease?: z.infer<typeof CodexTerminalMcpLeaseSchema>,
): NodeJS.ProcessEnv;

export function assertHerdrMcpReady(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
): Promise<void>;
export function createCodexTerminalMcpBootstrap(attemptId?: string): {
  bind(raw: unknown): Promise<boolean>;
  waitLease(signal: AbortSignal): Promise<z.infer<typeof CodexTerminalMcpLeaseSchema> | undefined>;
  markReady(): void;
  release(id: string): boolean;
  waitRelease(signal: AbortSignal): Promise<void>;
  fail(): void;
};
