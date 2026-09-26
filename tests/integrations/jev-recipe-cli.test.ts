import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createJevRoutes } from "../../packages/gateway/src/jev/routes.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { issueHermesIntegrationCapability, resolveHermesJevScope, type HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";

it("launches the actual credential-isolating host wrapper and packaged MCP CLI with only the broker", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-jev-cli-"));
  const client = new Client({ name: "recipe-native-fixture", version: "1" });
  const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: "bot_jevone01", revision: 1,
    account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
  const capability = issueHermesIntegrationCapability("owner_fixture", scope);
  let calls = 0;
  const app = new Hono();
  app.use("*", authMiddleware("fixture-machine-token"));
  app.route("/api/jev", createJevRoutes({ service: null,
    resolveOwnerId: c => requireRequestPrincipal(c).userId,
    resolveRecipeScope: c => resolveHermesJevScope(c.req.header("authorization")?.slice(7) ?? ""),
    inboxBroker: { clearRun: () => undefined, execute: async (ownerId, resolved, input) => {
      expect(ownerId).toBe("owner_fixture"); expect(resolved).toEqual(scope); expect(input).toEqual({ operation: "discover" });
      calls++; return { kind: "discovery", receipt: "a".repeat(64), threads: [], readonly: true };
    } },
  }));
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await app.fetch(new Request(`http://127.0.0.1${request.url}`, {
      method: request.method, headers: request.headers as HeadersInit, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const gateway = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    const launcher = (await readFile("distro/customer-vps/host-bin/matrix-integrations-mcp", "utf8"))
      .replace('NODE_BIN="/opt/matrix/runtime/node/bin/node"', `NODE_BIN="${process.execPath}"`)
      .replace('SERVER_PATH="/opt/matrix/app/packages/integrations-mcp/dist/cli.js"',
        `SERVER_PATH="${resolve("packages/integrations-mcp/dist/cli.js")}"`)
      .replace('GATEWAY_URL="http://127.0.0.1:4000"', `GATEWAY_URL="${gateway}"`);
    const fixture = join(home, "wrapper");
    await writeFile(fixture, launcher, { mode: 0o700 });
    const transport = new StdioClientTransport({ command: "bash", args: [fixture,
      "--require-scoped-capability", "--tool-surface=jev-inbox-preview"],
      env: { PATH: "/usr/bin:/bin", HOME: home, MATRIX_AGENT_INTEGRATIONS_TOKEN: capability.token,
        MATRIX_AUTH_TOKEN: "must-not-forward", UPGRADE_TOKEN: "must-not-forward" }, stderr: "pipe" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["jev_inbox_preview"]);
    const rejected = await client.callTool({ name: "jev_inbox_preview", arguments: { operation: "discover", ownerId: "forged" } });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain("must-not-forward");
    expect(calls).toBe(0);
    const result = await client.callTool({ name: "jev_inbox_preview", arguments: { operation: "discover" } });
    expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).toContain("a".repeat(64)); expect(calls).toBe(1);
    capability.revoke();
    expect((await client.callTool({ name: "jev_inbox_preview", arguments: { operation: "discover" } })).isError).toBe(true);
    expect(calls).toBe(1);
  } finally {
    capability.revoke(); await client.close(); http.closeAllConnections();
    await new Promise<void>(resolveClose => http.close(() => resolveClose()));
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
