import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatExecutionRootResolver, type ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { createFilePreviewService } from "../../packages/gateway/src/file-preview-service.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { registerProjectMetadataRoutes } from "../../packages/gateway/src/project-metadata-routes.js";
import { createProjectFilesLocationService, createProjectMetadataService } from "../../packages/gateway/src/project-metadata.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { registerGatewayProjectFileRoutes } from "../../packages/gateway/src/server/project-routes.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

const owner = { type: "user" as const, id: "owner" };
const other = { type: "user" as const, id: "other" };
const empty = { instructions: [], configFiles: [], skills: [], mcpServers: [], incompleteSources: [] };
const onLinux = it.skipIf(process.platform !== "linux");
let homePath: string;

beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "project-agent-context-"));
  vi.stubEnv("MATRIX_AUTH_TOKEN", "test-token");
  vi.stubEnv("MATRIX_USER_ID", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(homePath, { recursive: true, force: true });
});

function setup() {
  const runCommand = vi.fn();
  const getWorktree = vi.fn();
  const projects = createProjectManager({ homePath, runCommand });
  const executionRoots = createChatExecutionRootResolver({ homePath, projects, worktrees: { getWorktree } });
  async function project(slug: string, ownerScope = owner) {
    await mkdir(join(homePath, "checkouts", slug), { recursive: true });
    const created = await projects.createProject({
      mode: "folder", slug, name: slug, path: `checkouts/${slug}`, ownerScope,
    });
    if (!created.ok) throw new Error("Fixture project creation failed");
    return created.project;
  }
  function request(projectId: string, principal: string | null = owner.id, roots: ChatExecutionRootResolver | null = executionRoots) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      markAuthContextReady(c);
      if (principal) setPlatformVerifiedPrincipal(c, principal);
      await next();
    });
    registerGatewayProjectFileRoutes(app, {
      homePath,
      projects,
      executionRoots: roots,
      filePreviewService: createFilePreviewService({
        homePath,
        canAccessHome: () => false,
        resolveProjectRoot: async () => null,
      }),
    });
    return app.request(`/api/projects/${encodeURIComponent(projectId)}/agent-context`);
  }
  return { project, projects, executionRoots, request, runCommand, getWorktree };
}

async function addFile(root: string, path: string, body: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}

describe("project agent context", () => {
  it("requires the current personal owner and immutable active project ID", async () => {
    const { project, projects, request } = setup();
    const alpha = await project("alpha");
    const org = await project("organization", { type: "org", id: owner.id });
    const missing = await request("proj_missing");
    expect(missing.status).toBe(404);
    const body = await missing.json();
    for (const response of await Promise.all([
      request(alpha.id, other.id), request(alpha.slug), request(org.id),
    ])) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(body);
    }
    expect((await request(alpha.id, null)).status).toBe(401);
    expect((await request("..%/foreign")).status).toBe(400);
    expect((await request(alpha.id, owner.id, null)).status).toBe(503);
    expect(await projects.setProjectLifecycleState({
      slug: alpha.slug, ownerScope: owner, archivedAt: new Date().toISOString(),
    })).toMatchObject({ ok: true });
    expect((await request(alpha.id)).status).toBe(404);
  });

  onLinux("projects only source and names from this checkout without running a provider", async () => {
    const { project, request, runCommand, getWorktree } = setup();
    const a = await project("alpha");
    const b = await project("beta");
    const externalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    await Promise.all([
      addFile(a.localPath, "AGENTS.override.md", "private instructions"),
      addFile(a.localPath, "AGENTS.md", "private instructions"),
      addFile(a.localPath, "CLAUDE.md", "private instructions"),
      addFile(a.localPath, ".claude/CLAUDE.md", "private instructions"),
      addFile(a.localPath, ".agents/skills/docs/SKILL.md", "private skill body"),
      addFile(a.localPath, ".codex/skills/docs/SKILL.md", "private skill body"),
      addFile(a.localPath, ".mcp.json", '{"mcpServers":{"docs":{"url":"https://mcp.test","headers":{"Authorization":"private token"}}}}'),
      addFile(a.localPath, ".codex/config.toml", '[mcp_servers.docs]\ncommand = "private command"\nargs = ["private argument"]\n'),
      addFile(a.localPath, ".claude/settings.json", '{"env":{"TOKEN":"private token"}}'),
      addFile(a.localPath, "src/AGENTS.md", "nested instructions"),
      addFile(b.localPath, ".agents/skills/only-beta/SKILL.md", "private skill body"),
      addFile(homePath, ".mcp.json", '{"mcpServers":{"outside-project":{"url":"https://mcp.test"}}}'),
    ]);
    const aResponse = await request(a.id);
    expect(aResponse.status).toBe(200);
    expect(aResponse.headers.get("cache-control")).toBe("no-store");
    expect(await aResponse.json()).toEqual({
      instructions: ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"],
      configFiles: [".mcp.json", ".codex/config.toml", ".claude/settings.json"],
      skills: [{ name: "docs", source: ".agents/skills" }, { name: "docs", source: ".codex/skills" }],
      mcpServers: [{ name: "docs", source: ".mcp.json" }, { name: "docs", source: ".codex/config.toml" }],
      incompleteSources: [],
    });
    expect(await (await request(b.id)).json()).toEqual({
      ...empty, skills: [{ name: "only-beta", source: ".agents/skills" }],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(getWorktree).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
  });

  onLinux("marks malformed, nonregular, symlinked and oversized sources incomplete", async () => {
    const { project, request } = setup();
    const a = await project("alpha");
    const b = await project("beta", other);
    await addFile(b.localPath, ".mcp.json", '{"mcpServers":{"secret":{"url":"https://mcp.test"}}}');
    await addFile(b.localPath, ".agents/skills/beta/SKILL.md", "private skill body");
    await mkdir(join(a.localPath, ".codex"));
    await addFile(a.localPath, ".codex/config.toml", "x".repeat(65_537));
    await link(join(b.localPath, ".mcp.json"), join(a.localPath, ".mcp.json"));
    await symlink(join(b.localPath, ".agents"), join(a.localPath, ".agents"));
    await symlink(join(b.localPath, ".mcp.json"), join(a.localPath, "CLAUDE.md"));
    execFileSync("mkfifo", [join(a.localPath, "AGENTS.md")]);
    const response = await request(a.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...empty, configFiles: [".codex/config.toml"], incompleteSources: ["AGENTS.md", "CLAUDE.md", ".agents/skills", ".mcp.json", ".codex/config.toml"],
    });
    await rm(join(a.localPath, ".mcp.json"));
    await addFile(a.localPath, ".mcp.json", "{ invalid JSON");
    await addFile(a.localPath, ".codex/config.toml", "[invalid TOML");
    const malformed = await (await request(a.id)).json();
    expect(malformed).toMatchObject({
      configFiles: [".mcp.json", ".codex/config.toml"],
      mcpServers: [],
      incompleteSources: expect.arrayContaining([".mcp.json", ".codex/config.toml"]),
    });
  });

  onLinux("opens only a known regular config file within the current project", async () => {
    const { project, projects } = setup();
    const current = await project("alpha");
    const otherProject = await project("beta", other);
    const app = new Hono();
    registerProjectMetadataRoutes(app, {
      filesLocation: createProjectFilesLocationService({ homePath, projectManager: projects }),
      update: createProjectMetadataService({ homePath, projectManager: projects }),
      getOwnerScope: () => owner,
      principalError: () => new Response(null, { status: 401 }),
      admit: async () => ({ ok: false, status: 403, body: { error: "Unavailable" } }),
    });
    const getFile = (file: string, projectId = current.id) =>
      app.request(`/api/projects/alpha/files-location?${new URLSearchParams({ projectId, file })}`);
    await addFile(current.localPath, "AGENTS.md", "fixture instructions");
    expect(await (await getFile("AGENTS.md")).json()).toEqual({ path: "checkouts/alpha/AGENTS.md" });
    expect((await getFile("AGENTS.md", otherProject.id)).status).toBe(404);
    expect((await getFile(".mcp.json")).status).toBe(404);
    await addFile(otherProject.localPath, ".codex/config.toml", "[fixture]");
    await symlink(join(otherProject.localPath, ".codex"), join(current.localPath, ".codex"));
    await symlink(join(otherProject.localPath, ".codex/config.toml"), join(current.localPath, ".mcp.json"));
    expect((await getFile(".codex/config.toml")).status).toBe(404);
    expect((await getFile(".mcp.json")).status).toBe(404);
  });

  onLinux("creates a config file exclusively in the identified personal project", async () => {
    const { project, executionRoots } = setup();
    const active = await project("alpha");
    const foreign = await project("beta", other);
    const app = new Hono();
    registerFileRoutes(app, {
      homePath,
      getPrincipal: () => ({ userId: owner.id, source: "jwt" }),
      projectExecutionRoots: executionRoots,
    });
    const body = { path: "checkouts/alpha/AGENTS.md", projectId: active.id, projectFile: "AGENTS.md", content: "# Fixture" };
    const touch = (overrides: Partial<typeof body> = {}) => app.request("/api/files/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...overrides }),
    });
    expect((await touch({ projectId: "proj_replacement" })).status).toBe(404);
    expect((await touch({ projectId: foreign.id, path: "checkouts/beta/AGENTS.md" })).status).toBe(404);
    expect((await touch({ path: "outside/AGENTS.md" })).status).toBe(404);
    expect((await touch({ projectFile: "../AGENTS.md" })).status).toBe(400);
    expect((await touch()).status).toBe(200);
    expect((await touch({ content: "# Changed" })).status).toBe(409);
    expect(await readFile(join(homePath, body.path), "utf8")).toBe(body.content);
    await expect(stat(join(homePath, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
    const skill = ".agents/skills/release/SKILL.md";
    expect((await touch({ path: `checkouts/alpha/${skill}`, projectFile: skill })).status).toBe(200);
    expect(await readFile(join(active.localPath, skill), "utf8")).toBe(body.content);
    expect(await readdir(join(active.localPath, ".agents/skills/release"))).toEqual(["SKILL.md"]);

    await mkdir(join(foreign.localPath, ".codex"));
    await symlink(join(foreign.localPath, ".codex"), join(active.localPath, ".codex"));
    expect((await touch({ path: "checkouts/alpha/.codex/config.toml", projectFile: ".codex/config.toml" })).status).toBe(404);
    expect(await readdir(join(foreign.localPath, ".codex"))).toEqual([]);
  });

  it("rejects a skill over the UTF-8 byte limit before checking project access", async () => {
    const app = new Hono();
    registerFileRoutes(app, { homePath });
    const request = (content: string) => app.request("/api/files/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "checkouts/alpha/.agents/skills/release/SKILL.md",
        projectId: "proj_alpha",
        projectFile: ".agents/skills/release/SKILL.md",
        content,
      }),
    });
    const exact = "甲".repeat(21_845) + "a";
    expect((await request(exact)).status).toBe(503);
    expect((await request(exact + "a")).status).toBe(400);
  });

  onLinux("refuses scoped creation when the pinned checkout is replaced before writing", async () => {
    const { project, executionRoots } = setup();
    const active = await project("alpha");
    const oldRoot = `${active.localPath}-moved`;
    const app = new Hono();
    registerFileRoutes(app, {
      homePath,
      getPrincipal: () => ({ userId: owner.id, source: "jwt" }),
      projectExecutionRoots: {
        resolve: executionRoots.resolve,
        async revalidate(scope, provenance) {
          const result = await executionRoots.revalidate(scope, provenance);
          await rename(active.localPath, oldRoot);
          await mkdir(active.localPath);
          return result;
        },
      },
    });
    const response = await app.request("/api/files/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "checkouts/alpha/AGENTS.md", projectId: active.id, projectFile: "AGENTS.md", content: "# Fixture",
      }),
    });
    expect(response.status).toBe(404);
    expect(await readdir(active.localPath)).toEqual([]);
    expect(await readdir(oldRoot)).toEqual([]);
  });

  onLinux("bounds directory scanning and marks a truncated source incomplete", async () => {
    const { project, request } = setup();
    const a = await project("alpha");
    await Promise.all(Array.from({ length: 129 }, (_, i) => addFile(
      a.localPath, `.agents/skills/skill-${i}/SKILL.md`, "",
    )));
    const response = await request(a.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.incompleteSources).toEqual([".agents/skills"]);
    expect(body.skills).toHaveLength(64);
  });

  onLinux("discards a successful scan if the project directory changes before return", async () => {
    const { project, request, executionRoots } = setup();
    const a = await project("alpha");
    await addFile(a.localPath, "AGENTS.md", "private instructions");
    const roots: ChatExecutionRootResolver = {
      resolve: executionRoots.resolve,
      async revalidate(ownerScope, provenance) {
        await rename(a.localPath, `${a.localPath}-moved`);
        await mkdir(a.localPath);
        return executionRoots.revalidate(ownerScope, provenance);
      },
    };
    const response = await request(a.id, owner.id, roots);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("AGENTS.md");
  });

  it.skipIf(process.platform === "linux")("returns unavailable on a host without descriptor-relative directory access", async () => {
    const { project, request } = setup();
    const a = await project("alpha");
    await addFile(a.localPath, "AGENTS.md", "private instructions");
    expect((await request(a.id)).status).toBe(503);
  });
});
