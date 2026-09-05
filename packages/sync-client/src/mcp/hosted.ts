import { createMatrixMcpServer, type MatrixMcpServerOptions } from "./server.js";
import type { McpProfileContext } from "./profile-context.js";

// Hosted callers must supply identity explicitly. Never fall back to CLI login.
export function createHostedMatrixMcpServer(options: {
  context: McpProfileContext;
  fetch?: MatrixMcpServerOptions["fetch"];
  maxCommandTimeoutMs?: number;
}) {
  if (!options.context) throw new Error("Hosted MCP requires a request context");
  return createMatrixMcpServer(options);
}

export type { McpProfileContext, MatrixMcpComputer, MatrixMcpComputerList, MatrixMcpRuntime } from "./profile-context.js";
