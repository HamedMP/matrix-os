/**
 * Layer-6 integration checkpoint (spec 2691): a signed GitHub webhook pins a
 * Matrix Core repo commit through the real platform routes and sync job; a
 * member VPS installs it atomically through the real installer and the real
 * skills sync script; a broken push or a tampered tarball leaves the previous
 * version installed. Only GitHub and object storage are faked.
 */
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { c as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreRepoHttpTransport, createScriptSkillSync, installCoreRepo } from "../../packages/sync-client/src/core-repo/installer.js";
import type { CoreRepoDatabase } from "../../packages/platform/src/core-repo/database.js";
import { createPlatformCoreRepo } from "../../packages/platform/src/core-repo/startup.js";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";

const ORG = "org_acme1";
const MEMBER = "user_member";
const ADMIN = "user_admin";
const REPO = "acme/matrix-core";
const SECRET = "w".repeat(40);
const MACHINE = { "x-matrix-handle": "member-vps", authorization: "Bearer machine-token-0123456789abcdef" };
const T = new Date("2026-11-01T00:00:00.000Z");
const sha = (char: string) => char.repeat(40);

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;
}

async function tarball(work: string, commit: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<Uint8Array> {
  const root = `acme-matrix-core-${commit.slice(0, 7)}`;
  const dir = mkdtempSync(join(work, "src-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, root, path, ".."), { recursive: true });
    writeFileSync(join(dir, root, path), content);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, root, path));
  const chunks: Buffer[] = [];
  for await (const chunk of createTar({ gzip: true, cwd: dir, portable: true }, [root])) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("Matrix Core repo checkpoint", () => {
  let work: string;
  let home: string;
  let root: string;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<CoreRepoDatabase & OrganizationPlatformDatabase>;
  let organizations: PlatformOrganizationRepository;
  let head: string;
  const tarballs = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let platform: Awaited<ReturnType<typeof createPlatformCoreRepo>>;

  const github = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.pathname === "/app/installations/42/access_tokens") {
      const [header, payload, signature] = auth.slice(7).split(".");
      const valid = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(keys.publicKey, Buffer.from(signature!, "base64url"));
      expect(valid && JSON.parse(Buffer.from(payload!, "base64url").toString()).iss === "1234").toBe(true);
      return Response.json({ token: "ghs_installation" });
    }
    if (url.hostname === "api.github.com") expect(auth).toBe("Bearer ghs_installation");
    if (url.pathname === `/repos/${REPO}/commits/stable`) return new Response(head);
    const tar = /^\/repos\/acme\/matrix-core\/tarball\/([0-9a-f]{40})$/.exec(url.pathname);
    if (tar) return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/${REPO}/legacy.tar.gz/${tar[1]}?token=signed` } });
    const code = /^\/acme\/matrix-core\/legacy\.tar\.gz\/([0-9a-f]{40})$/.exec(url.pathname);
    if (url.hostname === "codeload.github.com" && code) {
      expect(auth).toBe("");
      return new Response(tarballs.get(code[1]!) ?? null, { status: tarballs.has(code[1]!) ? 200 : 404 });
    }
    throw new Error(`unexpected ${url.href}`);
  });

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), "core-repo-"));
    home = join(work, "home");
    root = join(work, "matrix-core");
    mkdirSync(join(home, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), skill("deploy"));
    mkdirSync(join(home, ".claude", "skills", "org-acme-notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "org-acme-notes", "SKILL.md"), skill("org-acme-notes"));
    pglite = await KyselyPGlite.create();
    db = new Kysely({ dialect: pglite.dialect });
    await bootstrapPlatformOrganizationDatabase(db);
    organizations = new PlatformOrganizationRepository(db);
    await organizations.applyOrganization({ organizationId: ORG, name: "Acme", slug: "acme", aiSubmission: "owner_only", sourceUpdatedAt: T });
    for (const [actorId, role] of [[MEMBER, "org:member"], [ADMIN, "org:admin"]] as const) {
      await organizations.applyMembership({ organizationId: ORG, membershipId: `m_${actorId}`, actorId, role, state: "active", sourceUpdatedAt: T });
    }
    platform = await createPlatformCoreRepo({
      env: { MATRIX_CORE_REPO_GITHUB_APP_ID: "1234", MATRIX_CORE_REPO_GITHUB_WEBHOOK_SECRET: SECRET,
        MATRIX_CORE_REPO_GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        MATRIX_CORE_REPO_SOURCES: JSON.stringify([{ orgId: ORG, installationId: 42, repository: REPO }]) },
      db, fetchImpl: github as unknown as typeof fetch, backgroundWorkers: false,
      store: {
        putObject: async (key, body) => { objects.set(key, Buffer.from(body)); return {}; },
        getObject: async (key) => ({ body: objects.has(key) ? new Response(objects.get(key)).body : null }),
        headObject: async (key) => ({ exists: objects.has(key) }),
        deleteObject: async (key) => { objects.delete(key); },
      },
      organizations: { repository: organizations, projection: {
        isCurrentMember: async (input) => (await organizations.getMembership(input))?.state === "active",
      } },
      authenticateMachine: async ({ handle, token }) => handle === "member-vps" && token === "machine-token-0123456789abcdef" ? MEMBER : null,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
    });
  });
  afterEach(async () => {
    await platform.shutdown();
    await db.destroy();
    rmSync(work, { recursive: true, force: true });
    tarballs.clear();
    objects.clear();
  });

  const push = (commit: string, delivery: string, options: { ref?: string; event?: string; secret?: string } = {}) => {
    const body = JSON.stringify({ ref: options.ref ?? "refs/heads/stable", after: commit, installation: { id: 42 }, repository: { full_name: REPO } });
    return platform.routes.request("/webhooks/github/core-repo", { method: "POST", body, headers: {
      "x-github-event": options.event ?? "push", "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", options.secret ?? SECRET).update(body).digest("hex")}` } });
  };
  const pinned = async () => (await sql<{ commit_sha: string | null; last_failure: string | null }>`SELECT commit_sha, last_failure FROM core_repo_pins WHERE organization_id = ${ORG}`.execute(db)).rows[0];
  const install = (targets = "claude") => installCoreRepo({
    root,
    transport: createCoreRepoHttpTransport({ baseUrl: "https://app.matrix-os.test", headers: MACHINE,
      fetchImpl: (async (url: string, init?: RequestInit) => platform.routes.request(new URL(url).pathname, init)) as typeof fetch }),
    runSkillSync: createScriptSkillSync(resolve("scripts/sync-matrix-agent-skills.sh"),
      { PATH: process.env.PATH, HOME: home, MATRIX_HOME: home, MATRIX_SKILL_TARGETS: targets }),
  });
  const claudeSkill = (name: string) => join(home, ".claude", "skills", name);

  it("pins a signed push, installs it atomically, and keeps the previous version on a broken push or tarball", async () => {
    head = sha("a");
    tarballs.set(head, await tarball(work, head, { "plugins/engineering/skills/deploy/SKILL.md": skill("deploy"), "AGENTS.md": "# Acme" }));

    expect((await push(head, "d-1", { secret: "x".repeat(40) })).status).toBe(401);
    expect((await push(head, "d-1", { event: "issues" })).status).toBe(204);
    expect((await push(head, "d-1", { ref: "refs/heads/main" })).status).toBe(204);
    expect((await push(head, "d-1")).status).toBe(202);
    expect((await push(head, "d-1")).status).toBe(204);
    await vi.waitFor(async () => expect(await pinned()).toEqual({ commit_sha: sha("a"), last_failure: null }));

    expect(await install()).toEqual([{ orgId: ORG, status: "installed", commit: sha("a") }]);
    const linked = realpathSync(claudeSkill("org-acme-deploy"));
    expect(linked).toBe(realpathSync(join(root, ORG, "releases", `${sha("a")}-acme`, ".matrix-skills", "org-acme-deploy")));
    expect(readFileSync(join(linked, "SKILL.md"), "utf8")).toContain("name: org-acme-deploy");
    expect(readlinkSync(join(root, ORG, "current"))).toBe(`releases/${sha("a")}-acme`);
    expect(readFileSync(join(claudeSkill("deploy"), "SKILL.md"), "utf8")).toBe(skill("deploy"));
    expect(lstatSync(claudeSkill("org-acme-notes")).isSymbolicLink()).toBe(false);
    expect(await install()).toEqual([{ orgId: ORG, status: "current", commit: sha("a") }]);

    // A broken push (a symlink in the repo) is never pinned.
    head = sha("b");
    tarballs.set(head, await tarball(work, head, { "skills/evil/SKILL.md": skill("evil") }, { "skills/evil/leak": "/etc/passwd" }));
    expect((await push(head, "d-2")).status).toBe(202);
    await vi.waitFor(async () => expect(await pinned()).toEqual({ commit_sha: sha("a"), last_failure: "archive" }));

    // A valid push whose stored tarball is tampered with fails the VPS checksum and changes nothing.
    head = sha("c");
    tarballs.set(head, await tarball(work, head, {
      "plugins/engineering/skills/deploy/SKILL.md": skill("deploy"), "skills/review/SKILL.md": skill("review"),
    }));
    expect((await push(head, "d-3")).status).toBe(202);
    await vi.waitFor(async () => expect((await pinned())?.commit_sha).toBe(sha("c")));
    const key = `core-repo/${ORG}/${sha("c")}.tar.gz`;
    const good = objects.get(key)!;
    // A well-formed substitute: only the pinned size + sha256 can tell it apart.
    objects.set(key, await tarball(work, head, { "skills/backdoor/SKILL.md": skill("backdoor") }));
    expect(await install()).toEqual([{ orgId: ORG, status: "failed" }]);
    expect(readlinkSync(join(root, ORG, "current"))).toBe(`releases/${sha("a")}-acme`);
    expect(realpathSync(claudeSkill("org-acme-deploy"))).toBe(linked);
    expect(() => lstatSync(claudeSkill("org-acme-review"))).toThrow();
    expect(() => lstatSync(claudeSkill("org-acme-backdoor"))).toThrow();

    objects.set(key, good);
    expect(await install()).toEqual([{ orgId: ORG, status: "installed", commit: sha("c") }]);
    expect(readlinkSync(join(root, ORG, "previous"))).toBe(`releases/${sha("a")}-acme`);
    expect(realpathSync(claudeSkill("org-acme-review"))).toContain(join(ORG, "releases", `${sha("c")}-acme`));

    // Membership ends: org skills and files go, personal skills stay.
    await organizations.applyMembership({ organizationId: ORG, membershipId: `m_${MEMBER}`, actorId: MEMBER, role: "org:member",
      state: "removed", sourceUpdatedAt: new Date(T.getTime() + 1_000) });
    expect(await install()).toEqual([{ orgId: ORG, status: "removed" }]);
    expect(() => lstatSync(claudeSkill("org-acme-deploy"))).toThrow();
    expect(() => lstatSync(join(root, ORG))).toThrow();
    expect(readFileSync(join(claudeSkill("deploy"), "SKILL.md"), "utf8")).toBe(skill("deploy"));
    expect(lstatSync(claudeSkill("org-acme-notes")).isDirectory()).toBe(true);
  });

  // Fault: an agent added after the first install never receives org skills, because the commit is unchanged.
  it("links an unchanged commit into agents added since the last install", async () => {
    head = sha("a");
    tarballs.set(head, await tarball(work, head, { "skills/deploy/SKILL.md": skill("deploy") }));
    expect((await push(head, "d-targets")).status).toBe(202);
    await vi.waitFor(async () => expect((await pinned())?.commit_sha).toBe(sha("a")));
    expect(await install("claude")).toEqual([{ orgId: ORG, status: "installed", commit: sha("a") }]);
    const hermesSkill = join(home, ".hermes", "skills", "org-acme-deploy");
    expect(() => lstatSync(hermesSkill)).toThrow();
    expect(await install("claude,hermes")).toEqual([{ orgId: ORG, status: "current", commit: sha("a") }]);
    expect(realpathSync(hermesSkill)).toBe(realpathSync(claudeSkill("org-acme-deploy")));
  });

  it("serves only the pinned commit to current members over the machine credential, and lets admins sync now", async () => {
    head = sha("a");
    tarballs.set(head, await tarball(work, head, { "skills/deploy/SKILL.md": skill("deploy") }));
    const manual = await platform.routes.request(`/api/orgs/${ORG}/core-repo/sync`, { method: "POST", headers: { "x-test-actor": ADMIN } });
    expect(await manual.json()).toEqual({ status: "pinned", commit: sha("a") });
    expect((await platform.routes.request(`/api/orgs/${ORG}/core-repo/sync`, { method: "POST", headers: { "x-test-actor": MEMBER } })).status).toBe(403);

    const get = (path: string, headers: Record<string, string> = MACHINE) => platform.routes.request(path, { headers });
    expect((await (await get("/internal/core-repo/pins")).json()).pins).toEqual([expect.objectContaining({ orgId: ORG, slug: "acme", commit: sha("a") })]);
    expect((await get(`/internal/core-repo/${ORG}/${sha("a")}.tar.gz`)).status).toBe(200);
    expect((await get(`/internal/core-repo/${ORG}/${sha("f")}.tar.gz`)).status).toBe(404);
    expect((await get(`/internal/core-repo/${ORG}/..%2Fsecrets.tar.gz`)).status).toBe(422);
    expect((await get("/internal/core-repo/pins", { ...MACHINE, authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    expect((await get("/internal/core-repo/pins", { "x-test-actor": "user_outsider" })).status).toBe(200);
    expect((await (await get("/internal/core-repo/pins", { "x-test-actor": "user_outsider" })).json()).pins).toEqual([]);
    expect((await get(`/internal/core-repo/${ORG}/${sha("a")}.tar.gz`, { "x-test-actor": "user_outsider" })).status).toBe(404);
  });
});
