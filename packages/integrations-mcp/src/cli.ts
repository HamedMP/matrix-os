#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createIntegrationsMcpServer, IntegrationsMcpToolSurfaceSchema } from "./server.js";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !args[0]!.startsWith("--tool-surface="))) {
    throw new Error("Invalid tool surface arguments");
  }
  const toolSurface = IntegrationsMcpToolSurfaceSchema.parse(
    args.length ? args[0]!.slice("--tool-surface=".length) : "full",
  );
  const server = createIntegrationsMcpServer({ toolSurface });
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err: unknown) {
  // stdout belongs exclusively to the MCP protocol.
  console.error(
    "matrix-integrations-mcp: failed to start",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
}
