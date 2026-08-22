#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createIntegrationsMcpServer } from "./server.js";

const server = createIntegrationsMcpServer();
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (err: unknown) {
  // stdout belongs exclusively to the MCP protocol.
  console.error(
    "matrix-integrations-mcp: failed to start",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
}
