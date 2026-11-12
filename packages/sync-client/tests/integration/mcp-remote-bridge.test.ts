/**
 * Spec 2691 layer 4: `matrix mcp login` + `matrix mcp bridge` end to end.
 * A fake Matrix OAuth authorization server (DCR + PKCE + refresh) and a real
 * MCP SDK Streamable HTTP server stand in for the platform `/mcp`; the CLI
 * code under test is production code over real loopback HTTP and real stdio
 * framing. Fault classes: token not owner-only, PKCE/state/resource unbound,
 * no pre-expiry refresh, unbounded frames, bearer leaked to stdout.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginRemoteMcp, loadRemoteMcpTokens, remoteMcpTokenPath, saveRemoteMcpTokens } from "../../src/mcp/remote-oauth.js";
import { runRemoteMcpBridge } from "../../src/mcp/remote-bridge.js";

interface FakePlatform {
  base: string;
  resource: string;
  server: Server;
  authorizeParams: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  mcpBearers: string[];
  validTokens: Set<string>;
  invalidGrants: number;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function startFakePlatform(): Promise<FakePlatform> {
  const state = { authorizeParams: [] as URLSearchParams[], tokenRequests: [] as URLSearchParams[], mcpBearers: [] as string[],
    validTokens: new Set<string>(), challenge: "", issued: 0, spentRefresh: new Set<string>(), invalidGrants: 0 };
  let base = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return send(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/oauth`], scopes_supported: ["matrix:computer"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/oauth") {
      return send(200, { issuer: `${base}/oauth`, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    }
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const registration = JSON.parse(await body(request)) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(registration.token_endpoint_auth_method).toBe("none");
      expect(registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      return send(201, { client_id: "bridge-client", redirect_uris: registration.redirect_uris });
    }
    if (url.pathname === "/oauth/authorize") {
      state.authorizeParams.push(url.searchParams);
      state.challenge = url.searchParams.get("code_challenge") ?? "";
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "auth-code-1");
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { location: redirect.toString() });
      return response.end();
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(await body(request));
      state.tokenRequests.push(form);
      if (form.get("resource") !== `${base}/mcp` || form.get("client_id") !== "bridge-client") return send(400, { error: "invalid_request" });
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== state.challenge || form.get("code") !== "auth-code-1") {
          return send(400, { error: "invalid_grant" });
        }
      } else if (form.get("grant_type") !== "refresh_token" || !form.get("refresh_token")?.startsWith("refresh-")
        || state.spentRefresh.has(form.get("refresh_token")!)) {
        state.invalidGrants += 1;
        return send(400, { error: "invalid_grant" });
      } else {
        // Rotation: each refresh token is single-use.
        state.spentRefresh.add(form.get("refresh_token")!);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const access = `access-${++state.issued}`;
      state.validTokens.add(access);
      return send(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${state.issued}` });
    }
    if (url.pathname === "/mcp") {
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      state.mcpBearers.push(bearer);
      if (!state.validTokens.has(bearer)) {
        return send(401, { error: "Unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      const mcp = new McpServer({ name: "fake-matrix", version: "1.0.0" });
      mcp.registerTool("list_services", { description: "List services." }, async () => ({ content: [{ type: "text", text: "linear-0a1b2c3d" }] }));
      mcp.registerTool("echo", { description: "Echo.", inputSchema: { value: z.string() } }, async ({ value }) => ({ content: [{ type: "text", text: value }] }));
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      const raw = await body(request);
      const result = await transport.handleRequest(new Request(url, { method: request.method,
        headers: request.headers as HeadersInit, body: request.method === "POST" ? raw : undefined }), { parsedBody: raw ? JSON.parse(raw) : undefined });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      await mcp.close();
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, resource: `${base}/mcp`, server, ...state, get validTokens() { return state.validTokens; },
    get invalidGrants() { return state.invalidGrants; } } as FakePlatform;
}

/** The "browser": follow the authorize redirect into the CLI's loopback callback. */
async function browser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  await fetch(authorize.headers.get("location")!);
}

function lines(stream: PassThrough): () => Promise<Record<string, unknown>> {
  let buffer = "";
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  stream.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line); else queue.push(line);
    }
  });
  return async () => JSON.parse(queue.shift() ?? await new Promise<string>(resolve => waiters.push(resolve)));
}

describe("matrix mcp bridge over Matrix OAuth", () => {
  let platform: FakePlatform;
  let configDir: string;
  beforeEach(async () => {
    platform = await startFakePlatform();
    configDir = await mkdtemp(join(tmpdir(), "matrix-mcp-bridge-"));
  });
  afterEach(async () => {
    await new Promise(resolve => platform.server.close(resolve));
    await rm(configDir, { recursive: true, force: true });
  });

  it("logs in with DCR + PKCE bound to the /mcp resource and stores an owner-only per-profile token", async () => {
    const stored = await loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: browser });
    expect(stored).toMatchObject({ resource: platform.resource, clientId: "bridge-client", accessToken: "access-1", refreshToken: "refresh-1" });
    const authorize = platform.authorizeParams[0]!;
    expect(Object.fromEntries(authorize)).toMatchObject({ response_type: "code", client_id: "bridge-client",
      code_challenge_method: "S256", resource: platform.resource, scope: "matrix:computer" });
    expect(authorize.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const path = remoteMcpTokenPath("cloud", configDir);
    expect(path).toBe(join(configDir, "profiles", "cloud", "mcp-oauth.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(configDir, "profiles", "cloud"))).mode & 0o077).toBe(0);
    expect(await loadRemoteMcpTokens("cloud", configDir)).toEqual(stored);
  });

  it("refuses a callback whose state does not match", async () => {
    const forged = async (url: string) => {
      const authorize = await fetch(url, { redirect: "manual" });
      const location = new URL(authorize.headers.get("location")!);
      location.searchParams.set("state", "forged-state-forged-state-forged-state");
      await fetch(location);
    };
    await expect(loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: forged, timeoutMs: 2_000 }))
      .rejects.toThrow();
    expect(platform.tokenRequests).toHaveLength(0);
    expect(await loadRemoteMcpTokens("cloud", configDir)).toBeNull();
  });

  it("bridges stdio JSON-RPC to /mcp, refreshing before expiry, and never writes the bearer to stdout", async () => {
    await loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: browser });
    const tokens = (await loadRemoteMcpTokens("cloud", configDir))!;
    await saveRemoteMcpTokens("cloud", { ...tokens, expiresAt: Date.now() + 5_000 }, configDir); // inside the refresh margin
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    const bridge = runRemoteMcpBridge({ profileName: "cloud", configDir, stdin, stdout });
    const send = (value: unknown) => stdin.write(`${JSON.stringify(value)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-client", version: "1" } } });
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "fake-matrix" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { value: "hello" } } });
    expect(await next()).toMatchObject({ id: 2, result: { content: [{ type: "text", text: "hello" }] } });
    expect(platform.mcpBearers.every(bearer => bearer === "access-2")).toBe(true);
    expect(platform.tokenRequests.map(form => form.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect((await loadRemoteMcpTokens("cloud", configDir))!.accessToken).toBe("access-2");
    stdin.end();
    await bridge;
    const written = await readFile(remoteMcpTokenPath("cloud", configDir), "utf8");
    expect(written).toContain("access-2");
    expect(stdout.readableLength).toBe(0);
  });

  it("refreshes once and retries when /mcp rejects a revoked bearer", async () => {
    await loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: browser });
    platform.validTokens.delete("access-1");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    const bridge = runRemoteMcpBridge({ profileName: "cloud", configDir, stdin, stdout });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_services", arguments: {} } })}\n`);
    expect(await next()).toMatchObject({ id: 7, result: { content: [{ text: "linear-0a1b2c3d" }] } });
    expect(platform.mcpBearers).toEqual(["access-1", "access-2"]);
    stdin.end();
    await bridge;
  });

  it("answers a request it cannot deliver with a generic JSON-RPC error and stops on an oversized frame", async () => {
    const tokens = await loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: browser });
    await saveRemoteMcpTokens("cloud", { ...tokens, refreshToken: "revoked-refresh-token" }, configDir);
    platform.validTokens.clear();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    const bridge = runRemoteMcpBridge({ profileName: "cloud", configDir, stdin, stdout, maxFrameBytes: 1024 });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    const failed = await next();
    expect(failed).toMatchObject({ id: 3, error: { code: -32603 } });
    expect(JSON.stringify(failed)).not.toContain("revoked-refresh-token");
    expect(JSON.stringify(failed)).not.toContain("access-1");
    const requests = platform.mcpBearers.length;
    stdin.write(`${"x".repeat(2048)}\n`);
    await expect(bridge).rejects.toThrow("frame");
    expect(platform.mcpBearers).toHaveLength(requests);
  });

  it("lets two bridges on one profile share a rotated refresh token instead of spending it twice", async () => {
    await loginRemoteMcp({ resource: platform.resource, profileName: "cloud", configDir, openBrowser: browser });
    const tokens = (await loadRemoteMcpTokens("cloud", configDir))!;
    await saveRemoteMcpTokens("cloud", { ...tokens, expiresAt: Date.now() + 5_000 }, configDir);
    const bridges = [0, 1].map(() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      return { stdin, next: lines(stdout), done: runRemoteMcpBridge({ profileName: "cloud", configDir, stdin, stdout }) };
    });
    bridges.forEach((bridge, index) => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10 + index, method: "tools/call",
      params: { name: "echo", arguments: { value: `bridge-${index}` } } })}\n`));
    const results = await Promise.all(bridges.map(bridge => bridge.next()));
    expect(results.map(result => (result.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(["bridge-0", "bridge-1"]);
    expect(platform.tokenRequests.filter(form => form.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(platform.invalidGrants).toBe(0);
    for (const bridge of bridges) bridge.stdin.end();
    await Promise.all(bridges.map(bridge => bridge.done));
  });

  it("tells the person to log in when the profile has no /mcp token", async () => {
    await writeFile(join(configDir, "placeholder"), "");
    await expect(runRemoteMcpBridge({ profileName: "cloud", configDir, stdin: new PassThrough(), stdout: new PassThrough() }))
      .rejects.toThrow("matrix mcp login");
  });
});
