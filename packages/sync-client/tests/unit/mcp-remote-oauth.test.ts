/**
 * Hosted Matrix MCP OAuth hardening (spec 2691, Greptile findings on #3311).
 * Faults: an unbounded metadata body is buffered before the cap; a non-JSON
 * 404 aborts discovery before the OpenID fallback; two bridge processes on
 * one profile spend each other's rotated refresh token.
 */
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRemoteMcpTokenSource,
  discoverRemoteMcpAuthorizationServer,
  loadRemoteMcpTokens,
  remoteMcpTokenPath,
  saveRemoteMcpTokens,
  type RemoteMcpTokens,
} from "../../src/mcp/remote-oauth.js";

const resource = "https://app.matrix-os.test/mcp";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("remote MCP OAuth discovery", () => {
  it("cancels a chunked metadata body with no Content-Length as soon as it passes the cap", async () => {
    let pulled = 0;
    let cancelled = false;
    const fetchStub: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024).fill(0x20)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(discoverRemoteMcpAuthorizationServer(new URL(resource), fetchStub)).rejects.toMatchObject({ code: "oauth_failed" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * 16 * 1024);
  });

  it("falls back to OpenID metadata when the RFC 8414 URL returns an HTML 404", async () => {
    const seen: string[] = [];
    const fetchStub: typeof fetch = async input => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json({ resource, authorization_servers: ["https://login.matrix-os.test/oauth"] });
      }
      if (url === "https://login.matrix-os.test/.well-known/oauth-authorization-server/oauth") {
        return new Response("<html><body>Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
      }
      if (url === "https://login.matrix-os.test/oauth/.well-known/openid-configuration") {
        return json({ issuer: "https://login.matrix-os.test/oauth", authorization_endpoint: "https://login.matrix-os.test/oauth/authorize",
          token_endpoint: "https://login.matrix-os.test/oauth/token", registration_endpoint: "https://login.matrix-os.test/oauth/register",
          code_challenge_methods_supported: ["S256"] });
      }
      return new Response("nope", { status: 500 });
    };
    await expect(discoverRemoteMcpAuthorizationServer(new URL(resource), fetchStub))
      .resolves.toMatchObject({ token_endpoint: "https://login.matrix-os.test/oauth/token" });
    expect(seen).toHaveLength(3);
  });
});

describe("remote MCP refresh across bridge processes", () => {
  let configDir: string;
  beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "matrix-mcp-oauth-")); });
  afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

  /** A token endpoint that rotates refresh tokens and rejects any spent one with invalid_grant. */
  function rotatingServer() {
    const state = { current: "refresh-0", issued: 0, grants: [] as string[], rejected: 0 };
    const fetchStub: typeof fetch = async (_input, init) => {
      const form = new URLSearchParams(String(init?.body));
      state.grants.push(form.get("refresh_token") ?? "");
      // Let a concurrent caller reach the server before this rotation lands.
      await new Promise(resolve => setTimeout(resolve, 20));
      if (form.get("refresh_token") !== state.current) { state.rejected += 1; return json({ error: "invalid_grant" }, 400); }
      state.issued += 1;
      state.current = `refresh-${state.issued}`;
      return json({ access_token: `access-${state.issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: state.current });
    };
    return { state, fetchStub };
  }

  const expiring = (): RemoteMcpTokens => ({ version: 1, resource, issuer: "https://login.matrix-os.test/oauth",
    tokenEndpoint: "https://login.matrix-os.test/oauth/token", clientId: "bridge-client",
    accessToken: "access-0", refreshToken: "refresh-0", expiresAt: Date.now() + 1_000 });

  it("lets two bridge processes refresh concurrently with exactly one rotation", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    const server = rotatingServer();
    // Separate token sources model separate processes: no shared memory, only the profile dir.
    const first = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: server.fetchStub });
    const second = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: server.fetchStub });
    await Promise.all([first.load(), second.load()]);
    const tokens = await Promise.all([first.accessToken(), second.accessToken()]);
    expect(tokens).toEqual(["access-1", "access-1"]);
    expect(server.state.grants).toEqual(["refresh-0"]);
    expect(server.state.rejected).toBe(0);
    expect((await loadRemoteMcpTokens("cloud", configDir))!.refreshToken).toBe("refresh-1");
    expect((await readdir(join(configDir, "profiles", "cloud"))).filter(name => name.endsWith(".lock"))).toEqual([]);
  });

  it("adopts the token another process rotated after this one's refresh token was spent", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    const server = rotatingServer();
    const stale = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: server.fetchStub });
    await stale.load(); // holds refresh-0 in memory
    const other = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: server.fetchStub });
    expect(await other.accessToken()).toBe("access-1");
    // The stale process's 401 path: it must not spend refresh-0 again.
    expect(await stale.afterRejected("access-0")).toBe("access-1");
    expect(server.state.rejected).toBe(0);
  });

  it("recovers a lock left by a dead process instead of waiting forever", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    await writeFile(`${remoteMcpTokenPath("cloud", configDir)}.lock`, JSON.stringify({ pid: 2_147_483_646, createdAt: Date.now(), nonce: "dead" }));
    const server = rotatingServer();
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: server.fetchStub });
    expect(await source.accessToken()).toBe("access-1");
  });
});
