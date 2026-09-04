import { defineCommand } from "citty";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMatrixMcpServer } from "../../mcp/server.js";

const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Start the Matrix remote-computer MCP server over stdio",
  },
  args: {
    profile: {
      type: "string",
      required: false,
      description: "Matrix CLI profile to use (default: active profile)",
    },
  },
  run: async ({ args }) => {
    const server = createMatrixMcpServer({
      profileName: typeof args.profile === "string" ? args.profile : undefined,
      apiOrigin: process.env.MATRIXOS_API_URL,
    });
    try {
      await server.connect(new StdioServerTransport());
    } catch (error: unknown) {
      console.error("Matrix MCP server failed to start.", error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    }
  },
});

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description: "Expose Matrix computers to coding agents over MCP",
  },
  subCommands: { serve: serveCommand },
  run: () => {
    console.error("Usage: matrix mcp serve [--profile <name>]");
    process.exitCode = 1;
  },
});
