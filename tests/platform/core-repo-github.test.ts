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

  // Fault: an oversized token or ref response is buffered whole in platform memory.
  it("caps the token and commit responses at 64 KB", async () => {
    const padded = (text: string) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.enqueue(new TextEncoder().encode(" ".repeat(70 * 1024)));
      controller.close();
    } }));
    const bigToken = vi.fn(async (url: string) => url.endsWith("/access_tokens") ? padded('{"token":"ghs_t"}') : new Response("a".repeat(40)));
    await expect(client(bigToken).headCommit(source)).rejects.toBeInstanceOf(CoreRepoUpstreamError);
    const bigCommit = vi.fn(async (url: string) => url.endsWith("/access_tokens") ? Response.json({ token: "ghs_t" }) : padded("a".repeat(40)));
    await expect(client(bigCommit).headCommit(source)).rejects.toBeInstanceOf(CoreRepoUpstreamError);
    const fine = vi.fn(async (url: string) => url.endsWith("/access_tokens") ? Response.json({ token: "ghs_t" }) : new Response(`${"a".repeat(40)}\n`));
    await expect(client(fine).headCommit(source)).resolves.toEqual({ commit: "a".repeat(40), token: "ghs_t" });
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

describe("Matrix Core repo webhook fan-out", () => {
  // Fault: two orgs share one installation and repository, and a push syncs only the first configured org.
  it("syncs every org whose installation, repository, and ref match the push", async () => {
    const { createHmac } = await import("node:crypto");
    const { createCoreRepoSyncService } = await import("../../packages/platform/src/core-repo/service.js");
    const { createCoreRepoRoutes } = await import("../../packages/platform/src/core-repo/routes.js");
    const shared = { installationId: 42, repository: "acme/matrix-core" };
    const sources = [
      { orgId: "org_alpha", ...shared, ref: "stable" },
      { orgId: "org_beta", ...shared, ref: "stable" },
      { orgId: "org_gamma", ...shared, ref: "main" },
      { orgId: "org_delta", installationId: 7, repository: "acme/matrix-core", ref: "stable" },
    ];
    const synced: string[] = [];
    const service = createCoreRepoSyncService({
      config: { sources },
      github: { headCommit: async (source) => { synced.push(source.orgId); throw new CoreRepoUpstreamError("ref"); }, downloadTarball: vi.fn() },
      store: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
      repository: { getPin: async () => null, recordFailure: async () => {} } as never,
    });
    const secret = "s".repeat(40);
    const routes = createCoreRepoRoutes({ service, repository: { claimDelivery: async () => true } as never, webhookSecret: secret,
      authenticateMachine: async () => null, resolveActor: async () => null });
    const body = JSON.stringify({ ref: "refs/heads/stable", after: "a".repeat(40), installation: { id: 42 }, repository: { full_name: "ACME/matrix-core" } });
    const response = await routes.request("/webhooks/github/core-repo", { method: "POST", body, headers: {
      "x-github-event": "push", "x-github-delivery": "d-1", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect([...synced].sort()).toEqual(["org_alpha", "org_beta"]));
    await service.stop();
  });
});

describe("Matrix Core repo tarball retention", () => {
  // Fault: every pushed commit's tarball stays in object storage forever, including ones whose pin write failed.
  it("keeps only the current and previous pinned tarballs and removes orphans from failed pin writes", async () => {
    const { KyselyPGlite } = await import("kysely-pglite");
    const { Kysely } = await import("kysely");
    const { bootstrapCoreRepoDatabase, createCoreRepoRepository } = await import("../../packages/platform/src/core-repo/database.js");
    const { createCoreRepoSyncService } = await import("../../packages/platform/src/core-repo/service.js");
    const { c: createTar } = await import("tar");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const work = mkdtempSync(join(tmpdir(), "core-gc-"));
    const tarball = async (commit: string) => {
      const dir = join(work, commit);
      mkdirSync(join(dir, "root", "skills", "x"), { recursive: true });
      writeFileSync(join(dir, "root", "skills", "x", "SKILL.md"), `---\nname: x\n---\n${commit}\n`);
      const chunks: Buffer[] = [];
      for await (const chunk of createTar({ gzip: true, cwd: dir, portable: true }, ["root"])) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks);
    };
    const db = new Kysely<never>({ dialect: (await KyselyPGlite.create()).dialect });
    try {
      await bootstrapCoreRepoDatabase(db as never);
      const real = createCoreRepoRepository(db as never);
      let failNextPin = false;
      const repository = { ...real, pin: async (record: Parameters<typeof real.pin>[0]) => {
        if (failNextPin) { failNextPin = false; throw new Error("connection reset"); }
        return real.pin(record);
      } };
      const objects = new Map<string, Uint8Array>();
      let head = "";
      const service = createCoreRepoSyncService({
        config: { sources: [source] },
        github: { headCommit: async () => ({ commit: head, token: "t" }), downloadTarball: async (_s, commit) => tarball(commit) },
        store: {
          putObject: async (key, body) => { objects.set(key, body); return {}; },
          getObject: vi.fn(),
          deleteObject: async (key) => { objects.delete(key); },
        },
        repository: repository as never,
        objectGraceMs: 0,
      });
      const key = (commit: string) => `core-repo/org_acme1/${commit}.tar.gz`;
      for (const char of ["a", "b", "c"]) {
        head = char.repeat(40);
        expect(await service.syncOrg("org_acme1")).toMatchObject({ status: "pinned" });
      }
      expect([...objects.keys()].sort()).toEqual([key("b".repeat(40)), key("c".repeat(40))]);

      head = "d".repeat(40);
      failNextPin = true;
      await expect(service.syncOrg("org_acme1")).rejects.toThrow();
      expect(objects.has(key(head))).toBe(true);
      head = "c".repeat(40);
      await service.syncAll();
      expect([...objects.keys()].sort()).toEqual([key("b".repeat(40)), key("c".repeat(40))]);
      await service.stop();
    } finally {
      await db.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("Matrix Core repo pins membership evidence", () => {
  const ORG_ID = "org_acme1";
  async function pinsWith(membershipState: string, current: boolean) {
    const { createCoreRepoRoutes } = await import("../../packages/platform/src/core-repo/routes.js");
    const routes = createCoreRepoRoutes({
      repository: { listPins: async () => [] } as never,
      organizations: {
        repository: {
          getMembership: vi.fn(), listMembers: vi.fn(),
          listOrganizationsForActorPage: async () => ({ complete: true,
            organizations: [{ organization: { organizationId: ORG_ID, slug: "acme", lifecycle: "active" }, membership: { state: membershipState } }] }),
        },
        projection: { isCurrentMember: async () => current },
      } as never,
      authenticateMachine: async () => "user_member",
      resolveActor: async () => null,
    });
    return routes.request("/internal/core-repo/pins", { headers: { "x-matrix-handle": "member-vps", authorization: "Bearer machine-token-0123456789" } });
  }

  // Fault: an unreachable Clerk or stale evidence reads as "not a member", and the installer deletes the org's skills.
  it("answers 503 when an active membership cannot be verified", async () => {
    expect((await pinsWith("active", false)).status).toBe(503);
  });

  it("reports verified membership when every listed org is confirmed", async () => {
    expect(await (await pinsWith("removed", false)).json()).toEqual({ pins: [], membership: "verified" });
    expect(await (await pinsWith("active", true)).json()).toEqual({ pins: [], membership: "verified" });
  });
});

describe("Matrix Core repo pins beyond one membership page", () => {
  // Fault: a member of more than 100 orgs gets a "verified" answer that omits orgs past the page cap, and loses their skills.
  it("never reports verified membership from a truncated organization list", async () => {
    const { KyselyPGlite } = await import("kysely-pglite");
    const { Kysely } = await import("kysely");
    const { bootstrapPlatformOrganizationDatabase } = await import("../../packages/platform/src/organizations/database.js");
    const { PlatformOrganizationRepository } = await import("../../packages/platform/src/organizations/repository.js");
    const { createCoreRepoRoutes } = await import("../../packages/platform/src/core-repo/routes.js");
    const db = new Kysely<never>({ dialect: (await KyselyPGlite.create()).dialect });
    try {
      await bootstrapPlatformOrganizationDatabase(db as never);
      const organizations = new PlatformOrganizationRepository(db as never);
      const at = new Date("2026-11-01T00:00:00.000Z");
      const request = async () => {
        const routes = createCoreRepoRoutes({
          repository: { listPins: async () => [] } as never,
          organizations: { repository: organizations, projection: { isCurrentMember: async () => true } } as never,
          authenticateMachine: async () => "user_member", resolveActor: async () => null,
        });
        return routes.request("/internal/core-repo/pins", { headers: { "x-matrix-handle": "member-vps", authorization: "Bearer machine-token-0123456789" } });
      };
      for (let index = 0; index < 101; index += 1) {
        const organizationId = `org_many${String(index).padStart(3, "0")}`;
        await organizations.applyOrganization({ organizationId, name: `Org ${index}`, slug: `org-${index}`, aiSubmission: "owner_only", sourceUpdatedAt: at });
        await organizations.applyMembership({ organizationId, membershipId: `m_${index}`, actorId: "user_member", role: "org:member", state: "active", sourceUpdatedAt: at });
        if (index === 99) expect(await (await request()).json()).toEqual({ pins: [], membership: "verified" });
      }
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pins: [] });
    } finally {
      await db.destroy();
    }
  });
});
