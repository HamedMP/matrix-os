import { defineCommand } from "citty";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMatrixMcpServer } from "../../mcp/server.js";
import { runRemoteMcpBridge } from "../../mcp/remote-bridge.js";
import { clearRemoteMcpTokens, loginRemoteMcp, trustedUrl } from "../../mcp/remote-oauth.js";
import { openBrowser } from "../../auth/oauth.js";
import { resolveCliProfile } from "../profiles.js";

const profileArg = {
  type: "string" as const,
  required: false as const,
  description: "Matrix CLI profile to use (default: active profile)",
};

/** The hosted Matrix Core MCP resource for a profile: `<platform>/mcp` unless overridden. */
async function remoteTarget(args: { profile?: unknown; url?: unknown }) {
  const profile = await resolveCliProfile({ profile: args.profile });
  const resource = trustedUrl(typeof args.url === "string" ? args.url : new URL("/mcp", profile.platformUrl).href);
  return { profileName: profile.name, resource: resource.href };
}

function fail(message: string, error: unknown): void {
  console.error(message, error instanceof Error && error.name === "RemoteMcpAuthError" ? error.message : "");
  process.exitCode = 1;
}

const loginCommand = defineCommand({
  meta: { name: "login", description: "Sign in to the hosted Matrix MCP (Matrix Core tools) for this profile" },
  args: { profile: profileArg, url: { type: "string", required: false, description: "Hosted MCP URL (default: <platform>/mcp)" } },
  run: async ({ args }) => {
    try {
      const target = await remoteTarget(args);
      await loginRemoteMcp({ ...target, openBrowser: (url) => {
        console.error(`Opening your browser to sign in to Matrix MCP. If it does not open, visit:\n${url}`);
        openBrowser(url);
      } });
      console.error("Matrix MCP sign-in complete.");
    } catch (error: unknown) { fail("Matrix MCP sign-in failed.", error); }
  },
});

const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Forget this profile's hosted Matrix MCP sign-in" },
  args: { profile: profileArg },
  run: async ({ args }) => {
    try {
      await clearRemoteMcpTokens((await resolveCliProfile({ profile: args.profile })).name);
    } catch (error: unknown) { fail("Matrix MCP sign-out failed.", error); }
  },
});

const bridgeCommand = defineCommand({
  meta: { name: "bridge", description: "Bridge a stdio-only MCP client to the hosted Matrix MCP (Matrix Core tools)" },
  args: { profile: profileArg },
  run: async ({ args }) => {
    try {
      // stdout belongs to the MCP protocol; diagnostics go to stderr only.
      await runRemoteMcpBridge({ profileName: (await resolveCliProfile({ profile: args.profile })).name });
    } catch (error: unknown) { fail("Matrix MCP bridge stopped.", error); }
  },
});

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
    description: "Expose Matrix computers (serve) or the hosted Matrix Core MCP (login, bridge) to coding agents",
  },
  subCommands: { serve: serveCommand, login: loginCommand, logout: logoutCommand, bridge: bridgeCommand },
});
