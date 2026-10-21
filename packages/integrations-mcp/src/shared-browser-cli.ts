#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSharedBrowserMcpServer } from "./shared-browser.js";
try {
  if (process.argv.length !== 2) throw new Error("Invalid browser arguments");
  const port = Number(process.env.MATRIX_SHARED_BROWSER_GATEWAY_PORT);
  const token = process.env.MATRIX_SHARED_BROWSER_TOKEN ?? "";
  const server = createSharedBrowserMcpServer({ gatewayPort: port, token });
  // Never hydrate machine-owner auth or provider environment: only this run's bearer is used.
  await server.connect(new StdioServerTransport());
} catch (error: unknown) {
  console.error("matrix-shared-browser: unavailable", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
}
