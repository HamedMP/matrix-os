/** Matrix Core repo config and GitHub transport boundaries (spec 2691, layer 6). */
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createPlatformCoreRepo } from "../../packages/platform/src/core-repo/startup.js";
import { parseCoreRepoConfig } from "../../packages/platform/src/core-repo/config.js";
import { CoreRepoUpstreamError, createGitHubCoreRepoClient } from "../../packages/platform/src/core-repo/github.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = (overrides: Record<string, string | undefined> = {}) => ({
  MATRIX_CORE_REPO_GITHUB_APP_ID: "1234", MATRIX_CORE_REPO_GITHUB_APP_PRIVATE_KEY: key,
  MATRIX_CORE_REPO_GITHUB_WEBHOOK_SECRET: "s".repeat(40),
  MATRIX_CORE_REPO_SOURCES: JSON.stringify([{ orgId: "org_acme1", installationId: 42, repository: "acme/matrix-core" }]),
  ...overrides,
});
const source = { orgId: "org_acme1", installationId: 42, repository: "acme/matrix-core", ref: "stable" };

describe("Matrix Core repo config", () => {
  // Fault: a half-configured or hostile config enables the feature anyway.
  it("enables only complete, valid configuration and defaults the ref to stable", () => {
    expect(parseCoreRepoConfig(env())?.sources).toEqual([source]);
    for (const broken of [
      { MATRIX_CORE_REPO_GITHUB_APP_ID: undefined },
      { MATRIX_CORE_REPO_GITHUB_APP_PRIVATE_KEY: "not a key" },
      { MATRIX_CORE_REPO_GITHUB_WEBHOOK_SECRET: "short" },
      { MATRIX_CORE_REPO_SOURCES: "{" },
      { MATRIX_CORE_REPO_SOURCES: JSON.stringify([{ orgId: "org_acme1", installationId: 42, repository: "../etc" }]) },
      { MATRIX_CORE_REPO_SOURCES: JSON.stringify([{ orgId: "org_acme1", installationId: 42, repository: "a/b", ref: "../main" }]) },
      { MATRIX_CORE_REPO_SOURCES: JSON.stringify([{ ...source }, { ...source, repository: "acme/other" }]) },
    ]) expect(parseCoreRepoConfig(env(broken))).toBeNull();
  });
});

describe("GitHub Core repo client", () => {
  const client = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
    createGitHubCoreRepoClient({ appId: "1234", privateKey: key, fetchImpl: fetchImpl as typeof fetch });

  // Fault: the tarball redirect sends the installation token to, or downloads from, another host.
  it("follows the tarball redirect only to codeload, without the token, and caps the body", async () => {
    const calls: Array<{ url: string; auth: string | null; redirect?: RequestRedirect; signal?: boolean }> = [];
    let location = "https://codeload.github.com/acme/matrix-core/legacy.tar.gz/x";
    let body = new Uint8Array(10);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
      return url.startsWith("https://api.github.com") ? new Response(null, { status: 302, headers: { location } }) : new Response(body);
    });
    expect((await client(fetchImpl).downloadTarball(source, "a".repeat(40), "ghs_t")).byteLength).toBe(10);
    expect(calls).toEqual([
      { url: `https://api.github.com/repos/acme/matrix-core/tarball/${"a".repeat(40)}`, auth: "Bearer ghs_t", redirect: "manual", signal: true },
      { url: location, auth: null, redirect: "error", signal: true },
    ]);
    for (const hostile of ["https://evil.test/x", "http://codeload.github.com/x", "not a url"]) {
      location = hostile;
      await expect(client(fetchImpl).downloadTarball(source, "a".repeat(40), "ghs_t")).rejects.toMatchObject({ reason: "download" });
    }
    location = "https://codeload.github.com/x";
    body = new Uint8Array(50 * 1024 * 1024 + 1);
    await expect(client(fetchImpl).downloadTarball(source, "a".repeat(40), "ghs_t")).rejects.toBeInstanceOf(CoreRepoUpstreamError);
  });

  it("rejects a ref that does not resolve to a commit sha", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/access_tokens")
      ? Response.json({ token: "ghs_t" }) : new Response("<html>not a sha</html>"));
    await expect(client(fetchImpl).headCommit(source)).rejects.toMatchObject({ reason: "ref" });
  });
});

describe("Matrix Core repo composition", () => {
  // Fault: a half-configured platform serves org content or reports a missing feature as not found.
  it("answers 503 everywhere when the feature is off, and startup mounts and drains it", async () => {
    const off = await createPlatformCoreRepo({ env: env({ MATRIX_CORE_REPO_SOURCES: undefined }), db: {} as never, backgroundWorkers: true,
      authenticateMachine: async () => "user_member", resolveActor: async () => "user_admin" });
    for (const [method, path] of [["POST", "/webhooks/github/core-repo"], ["GET", "/internal/core-repo/pins"],
      ["GET", `/internal/core-repo/org_acme1/${"a".repeat(40)}.tar.gz`], ["POST", "/api/orgs/org_acme1/core-repo/sync"]] as const) {
      const response = await off.routes.request(path, { method, headers: { "x-matrix-handle": "member-vps", authorization: "Bearer machine-token-0123456789" } });
      expect(response.status).toBe(503);
    }
    await off.shutdown();
    const startup = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(startup).toContain("coreRepoRoutes: coreRepo.routes");
    expect(startup).toMatch(/customMcpShutdown\?\.\(\),\s*coreRepo\.shutdown\(\),/);
    expect(await readFile("packages/platform/src/main.ts", "utf8")).toContain("if (deps.coreRepoRoutes) app.route('/', deps.coreRepoRoutes);");
  });
});
