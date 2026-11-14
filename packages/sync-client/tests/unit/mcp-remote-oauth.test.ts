/**
 * Hosted Matrix MCP OAuth hardening (spec 2691, Greptile findings on #3311).
 * Faults: an unbounded metadata body is buffered before the cap; a non-JSON
 * 404 aborts discovery before the OpenID fallback; two bridge processes on
 * one profile spend each other's rotated refresh token; a refresh that was in
 * flight during `matrix mcp login`/`logout` overwrites the new login or
 * recreates the deleted credentials.
 */
import { mkdtemp, rm, writeFile, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRemoteMcpTokens,
  createRemoteMcpTokenSource,
  discoverRemoteMcpAuthorizationServer,
  loadRemoteMcpTokens,
  loginRemoteMcp,
  remoteMcpTokenPath,
  saveRemoteMcpTokens,
  type RemoteMcpTokens,
} from "../../src/mcp/remote-oauth.js";
import { withProfileRefreshLock } from "../../src/mcp/remote-oauth-lock.js";

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

describe("remote MCP refresh lock", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "matrix-mcp-lock-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("never reclaims a just-created lock whose content is not written yet", async () => {
    // Fault: a racer saw an empty lock as torn and deleted a live holder's lock.
    const path = join(dir, "mcp-oauth.json.lock");
    await writeFile(path, "");
    let ran = false;
    await expect(withProfileRefreshLock(path, async () => { ran = true; }, { waitMs: 300 })).rejects.toThrow("busy");
    expect(ran).toBe(false);
    expect((await stat(path)).size).toBe(0);
  });

  it("reclaims an unreadable lock only after its grace period", async () => {
    const path = join(dir, "mcp-oauth.json.lock");
    await writeFile(path, "{\"pid\":");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    await expect(withProfileRefreshLock(path, async () => "ran", { waitMs: 300 })).resolves.toBe("ran");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the lock with its full content in one step", async () => {
    const path = join(dir, "mcp-oauth.json.lock");
    await withProfileRefreshLock(path, async () => {
      const held = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as { pid: number; nonce: string };
      expect(held.pid).toBe(process.pid);
      expect(held.nonce).toMatch(/^[a-f0-9]{32}$/);
    });
    expect((await readdir(dir))).toEqual([]);
  });
});

describe("remote MCP token source binding", () => {
  let configDir: string;
  beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "matrix-mcp-bind-")); });
  afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

  const tokensFor = (host: string, expiresAt: number): RemoteMcpTokens => ({ version: 1, resource: `https://${host}/mcp`,
    issuer: `https://${host}/oauth`, tokenEndpoint: `https://${host}/oauth/token`, clientId: `client-${host}`,
    accessToken: `access-${host}`, refreshToken: `refresh-${host}`, expiresAt });

  it("refuses to adopt or refresh tokens a different login saved to the same profile", async () => {
    // Fault: `matrix mcp login --url B` on the profile hands B's bearer to a bridge talking to A.
    await saveRemoteMcpTokens("cloud", tokensFor("a.matrix-os.test", Date.now() + 1_000), configDir);
    const requested: string[] = [];
    const fetchStub: typeof fetch = async input => { requested.push(String(input)); return json({ error: "unexpected" }, 500); };
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: fetchStub });
    expect((await source.load()).resource).toBe("https://a.matrix-os.test/mcp");
    await saveRemoteMcpTokens("cloud", tokensFor("b.matrix-os.test", Date.now() + 3_600_000), configDir);
    await expect(source.accessToken()).rejects.toThrow("profile login changed; restart the bridge");
    await expect(source.afterRejected("access-a.matrix-os.test")).rejects.toThrow("profile login changed; restart the bridge");
    expect(requested).toEqual([]);
  });

  it("refuses a mismatched login saved while its own refresh failed", async () => {
    await saveRemoteMcpTokens("cloud", tokensFor("a.matrix-os.test", Date.now() + 1_000), configDir);
    const fetchStub: typeof fetch = async () => {
      await saveRemoteMcpTokens("cloud", tokensFor("b.matrix-os.test", Date.now() + 3_600_000), configDir);
      return json({ error: "invalid_grant" }, 400);
    };
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: fetchStub });
    await expect(source.accessToken()).rejects.toThrow("profile login changed; restart the bridge");
  });
});

describe("remote MCP login, logout and refresh serialization", () => {
  let configDir: string;
  beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "matrix-mcp-serial-")); });
  afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

  const issuer = "https://login.matrix-os.test/oauth";
  const expiring = (): RemoteMcpTokens => ({ version: 1, resource, issuer, tokenEndpoint: `${issuer}/token`,
    clientId: "bridge-client", accessToken: "access-0", refreshToken: "refresh-0", expiresAt: Date.now() + 1_000 });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  /** A refresh endpoint that reports when it is entered and answers only once released. */
  function gatedRefresh() {
    const entered = deferred();
    const release = deferred();
    const grants: string[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      grants.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      entered.resolve();
      await release.promise;
      return json({ access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600, refresh_token: "refreshed-refresh" });
    };
    return { entered, release, grants, fetchStub };
  }

  it("keeps credentials deleted when logout runs while a refresh is in flight", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    const refresh = gatedRefresh();
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: refresh.fetchStub });
    const refreshing = source.accessToken();
    await refresh.entered.promise;
    const logout = clearRemoteMcpTokens("cloud", configDir);
    setTimeout(() => refresh.release.resolve(), 30);
    await Promise.allSettled([refreshing, logout]);
    await expect(logout).resolves.toBeUndefined();
    expect(await loadRemoteMcpTokens("cloud", configDir)).toBeNull();
  });

  it("never recreates credentials that logout removed before the refresh took the lock", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    const refresh = gatedRefresh();
    refresh.release.resolve();
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: refresh.fetchStub });
    await source.load();
    await clearRemoteMcpTokens("cloud", configDir);
    await expect(source.accessToken()).rejects.toMatchObject({ code: "login_required" });
    expect(refresh.grants).toEqual([]);
    expect(await loadRemoteMcpTokens("cloud", configDir)).toBeNull();
  });

  it("keeps a new login that finishes while a refresh is in flight", async () => {
    await saveRemoteMcpTokens("cloud", expiring(), configDir);
    const refresh = gatedRefresh();
    const source = createRemoteMcpTokenSource({ profileName: "cloud", configDir, fetch: refresh.fetchStub });
    const refreshing = source.accessToken();
    await refresh.entered.promise;

    const loginFetch: typeof fetch = async input => {
      const url = String(input);
      if (url === "https://app.matrix-os.test/.well-known/oauth-protected-resource/mcp") {
        return json({ resource, authorization_servers: [issuer] });
      }
      if (url === "https://login.matrix-os.test/.well-known/oauth-authorization-server/oauth") {
        return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ["S256"] });
      }
      if (url === `${issuer}/register`) return json({ client_id: "bridge-client" }, 201);
      if (url === `${issuer}/token`) {
        // The refresh answers only after this login has its tokens and tries to save them.
        setTimeout(() => refresh.release.resolve(), 30);
        return json({ access_token: "login-access", token_type: "Bearer", expires_in: 3600, refresh_token: "login-refresh" });
      }
      return new Response("nope", { status: 500 });
    };
    const openBrowser = async (href: string) => {
      const authorize = new URL(href);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      await (await fetch(callback, { signal: AbortSignal.timeout(5_000) })).body?.cancel();
    };
    const login = loginRemoteMcp({ resource, profileName: "cloud", configDir, openBrowser, fetch: loginFetch, timeoutMs: 5_000 });
    await Promise.allSettled([refreshing, login]);
    await expect(login).resolves.toMatchObject({ refreshToken: "login-refresh" });
    expect(await loadRemoteMcpTokens("cloud", configDir)).toMatchObject({ accessToken: "login-access", refreshToken: "login-refresh" });
  });
});
