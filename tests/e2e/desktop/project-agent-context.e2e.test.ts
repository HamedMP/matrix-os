import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { dismissGettingStartedOnInteraction } from "./fixtures/getting-started";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const built = existsSync(main);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) {
  throw new Error("Required Electron Desktop build is missing");
}

const projects = [
  { id: "proj_agent_alpha", slug: "atlas", name: "Atlas", description: "Documentation and release workflows.", kind: "scratch" },
  { id: "proj_agent_beta", slug: "harbor", name: "Harbor", description: "Independent workspace.", kind: "scratch" },
] as const;

const releaseSkillPath = ".agents/skills/release-check/SKILL.md";
const newSkillPath = ".agents/skills/migration-notes/SKILL.md";
const mcpPath = ".mcp.json";
const instructionPath = "CLAUDE.md";
const atlasRoot = "projects/atlas/";

const harborInventory = {
  instructions: ["AGENTS.override.md"],
  skills: [{ name: "harbor-check", source: ".codex/skills" }],
  mcpServers: [],
  incompleteSources: [],
};

const evidence = process.env.MATRIX_PROJECT_CONTEXT_EVIDENCE_DIR;
const liveInventory = process.env.MATRIX_PROJECT_CONTEXT_LOCAL_GATEWAY_URL
  ? new URL(process.env.MATRIX_PROJECT_CONTEXT_LOCAL_GATEWAY_URL)
  : undefined;
if (liveInventory && (liveInventory.protocol !== "http:" || liveInventory.hostname !== "127.0.0.1")) {
  throw new Error("The project inventory fixture must be on loopback");
}

describe.skipIf(!built)("Electron Desktop project agent context", () => {
  let gateway: StubGateway;
  let server: Server;
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  const inventoryRequests: string[] = [];
  let projectListRequests = 0;
  let filesLocationRequests = 0;
  const exactFiles: string[] = [];
  const createRequests: { file: string; content: string }[] = [];
  const saveRequests: string[] = [];
  const mcpMutations: string[] = [];
  let revision = 0;
  const fixtureFiles = new Map<string, { content: string; modified: string }>();
  const storeFile = (file: string, content: string) => {
    const modified = new Date(Date.UTC(2026, 10, 10, 0, 0, revision++)).toISOString();
    fixtureFiles.set(file, { content, modified });
    return modified;
  };
  storeFile(releaseSkillPath, "# Release check\nFixture skill for the Atlas project.\n");
  storeFile(".claude/skills/review-notes/SKILL.md", "# Review notes\n");
  storeFile("AGENTS.md", "# Atlas instructions\n");
  storeFile(".codex/config.toml", "[mcp_servers.issue-tracker]\n");
  storeFile(".claude/settings.json", "{}\n");

  const atlasInventory = () => {
    const jsonMcp = JSON.parse(fixtureFiles.get(mcpPath)?.content ?? "{}") as { mcpServers?: Record<string, unknown> };
    return {
      instructions: ["AGENTS.md", instructionPath].filter(file => fixtureFiles.has(file)),
      configFiles: [mcpPath, ".codex/config.toml", ".claude/settings.json"].filter(file => fixtureFiles.has(file)),
      skills: [...fixtureFiles.keys()].flatMap(file => {
        const skill = /^(\.[^/]+\/skills)\/([^/]+)\/SKILL\.md$/.exec(file);
        return skill ? [{ source: skill[1], name: skill[2] }] : [];
      }),
      mcpServers: [
        { name: "issue-tracker", source: ".codex/config.toml" },
        ...Object.keys(jsonMcp.mcpServers ?? {}).map(name => ({ name, source: mcpPath })),
      ],
      incompleteSources: [],
    };
  };

  beforeAll(async () => {
    if (evidence) mkdirSync(evidence, { recursive: true });
    gateway = await startStubGateway();
    server = createServer((req, res) => {
      const { pathname: path, search, searchParams } = new URL(req.url ?? "/", gateway.url);
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && path === "/api/workspace/projects") {
        projectListRequests++;
        json({ projects });
        return;
      }
      if (req.method === "GET" && path === "/api/projects/atlas/files-location") {
        const file = searchParams.get("file");
        if (file) {
          if (searchParams.get("projectId") !== projects[0].id || !fixtureFiles.has(file)) {
            res.writeHead(404).end();
            return;
          }
          exactFiles.push(`${projects[0].id}:${file}`);
          json({ path: `${atlasRoot}${file}` });
          return;
        }
        filesLocationRequests++;
        json({ path: "projects/atlas" });
        return;
      }
      if (req.method === "GET" && path === "/api/files/list" && searchParams.get("path") === "projects/atlas") {
        json({ entries: [{ name: "project-instructions-fixture.md", type: "file", size: 42, modified: "2026-11-10T00:00:00.000Z" }] });
        return;
      }
      if (req.method === "POST" && path === "/api/files/touch") {
        let payload = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => { payload += chunk; });
        req.on("end", () => {
          const body = JSON.parse(payload) as Record<string, unknown>;
          const file = body.projectFile;
          if (body.projectId !== projects[0].id || typeof file !== "string"
            || ![newSkillPath, mcpPath, instructionPath].includes(file)
            || body.path !== `${atlasRoot}${file}` || typeof body.content !== "string") {
            res.writeHead(400).end();
            return;
          }
          if (fixtureFiles.has(file)) {
            res.writeHead(409).end();
            return;
          }
          createRequests.push({ file, content: body.content });
          storeFile(file, body.content);
          json({ ok: true, path: body.path });
        });
        return;
      }
      const pathParam = searchParams.get("path");
      const relativeFile = pathParam?.startsWith(atlasRoot) ? pathParam.slice(atlasRoot.length) : null;
      const fixtureFile = relativeFile ? fixtureFiles.get(relativeFile) : undefined;
      if (relativeFile && fixtureFile) {
        if (req.method === "GET" && path === "/api/files/stat") {
          json({ modified: fixtureFile.modified });
          return;
        }
        if (req.method === "GET" && path === "/api/files/blob") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(fixtureFile.content);
          return;
        }
        if (req.method === "PUT" && path === "/api/files/blob") {
          let content = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => { content += chunk; });
          req.on("end", () => {
            saveRequests.push(relativeFile);
            json({ ok: true, modified: storeFile(relativeFile, content) });
          });
          return;
        }
      }
      if (path === "/api/mcp-servers" || path.startsWith("/api/mcp-servers/")) {
        if (req.method === "GET" && path === "/api/mcp-servers") json([]);
        else {
          mcpMutations.push(`${req.method} ${path}`);
          res.writeHead(405).end();
        }
        return;
      }
      const project = projects.find(item => path === `/api/projects/${item.id}/agent-context`);
      if (project && req.method === "GET") {
        inventoryRequests.push(project.id);
        if (!liveInventory) {
          json(project.id === projects[0].id ? atlasInventory() : harborInventory);
          return;
        }
      }
      const target = new URL(project && liveInventory ? liveInventory : gateway.url);
      target.pathname = path;
      target.search = search;
      const upstream = request(target, {
        method: req.method,
        headers: req.headers,
        timeout: 10_000,
      }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("Fixture timed out")));
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    profile = mkdtempSync(join(tmpdir(), "matrix-project-context-e2e-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: `http://127.0.0.1:${port}`, OPERATOR_USER_DATA_DIR: profile },
    });
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await dismissGettingStartedOnInteraction(page);
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("creates and saves project skills, MCP and instructions through the actual Editor", async () => {
    onTestFailed(async () => {
      if (evidence && !page.isClosed()) {
        console.error("Project fixture requests", { projectListRequests, inventoryRequests });
        console.error((await page.locator("body").ariaSnapshot({ timeout: 2_000 })).slice(0, 4_000));
        await page.screenshot({ path: join(evidence, "electron-failure.png"), timeout: 2_000 });
      }
    });
    const openProject = async (name: string) => {
      await page.getByRole("button", { name: "Search", exact: true }).click({ timeout: 20_000 });
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByPlaceholder("Type a command or search…").fill(name);
      await palette.getByRole("option", { name, exact: true }).click();
      await page.getByRole("heading", { name, exact: true }).waitFor();
    };
    await openProject("Atlas");
    const projectWindow = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Atlas", exact: true }) });
    const maximize = projectWindow.getByRole("button", { name: "Maximize", exact: true });
    if (await maximize.isVisible()) await maximize.click();
    expect(inventoryRequests).toEqual([]);
    await page.getByRole("button", { name: "Agent configuration", exact: true }).click();
    const sections = page.getByRole("region", { name: "Agent configuration", exact: true });
    const skills = sections.getByRole("button", { name: "Skills", exact: true });
    const mcp = sections.getByRole("button", { name: "MCP", exact: true });
    const configFiles = sections.getByRole("button", { name: "Config files", exact: true });
    await page.getByText("release-check", { exact: true }).waitFor();
    expect(await skills.getAttribute("aria-expanded")).toBe("true");
    expect(await mcp.getAttribute("aria-expanded")).toBe("false");
    expect(await configFiles.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByText("harbor-check", { exact: true }).count()).toBe(0);
    if (evidence) await page.screenshot({ path: join(evidence, "electron-project-agent-configuration-compact.png") });
    await mcp.click();
    await page.getByText("issue-tracker", { exact: true }).waitFor();
    expect(await skills.getAttribute("aria-expanded")).toBe("false");
    if (evidence) await page.screenshot({ path: join(evidence, "electron-project-agent-configuration-mcp-expanded.png") });
    await skills.click();
    await page.getByRole("button", { name: "Open .agents/skills/release-check/SKILL.md", exact: true }).click();
    await expect.poll(() => exactFiles).toEqual(["proj_agent_alpha:.agents/skills/release-check/SKILL.md"]);
    await page.getByRole("button", { name: "Save projects/atlas/.agents/skills/release-check/SKILL.md", exact: true }).waitFor();
    await page.getByRole("button", { name: "Markdown preview", exact: true }).click();
    await page.getByText("Fixture skill for the Atlas project.", { exact: true }).waitFor();
    if (evidence) await page.screenshot({ path: join(evidence, "electron-project-skill-editor-compact.png") });

    await openProject("Atlas");
    const configuration = page.getByRole("button", { name: "Agent configuration", exact: true });
    if (await configuration.getAttribute("aria-expanded") === "false") await configuration.click();
    if (await configFiles.getAttribute("aria-expanded") === "false") await configFiles.click();
    await page.getByText("AGENTS.md", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Open project files", exact: true }).click();
    await expect.poll(() => filesLocationRequests).toBe(1);
    await page.getByText("project-instructions-fixture.md", { exact: true }).first().waitFor();

    await openProject("Atlas");
    const context = page.getByRole("button", { name: "Agent configuration", exact: true });
    if (await context.getAttribute("aria-expanded") === "false") await context.click();
    if (await mcp.getAttribute("aria-expanded") === "false") await mcp.click();
    await page.getByRole("button", { name: "Open MCP settings", exact: true }).click();
    await page.getByRole("heading", { name: "MCP servers", exact: true }).waitFor();

    if (!liveInventory) {
      const returnTo = async (section: typeof skills) => {
        await openProject("Atlas");
        if (await context.getAttribute("aria-expanded") === "false") await context.click();
        if (await section.getAttribute("aria-expanded") === "false") await section.click();
      };
      const saveEdit = async (file: string, content: string, capture: string) => {
        const fullPath = `${atlasRoot}${file}`;
        const save = page.getByRole("button", { name: `Save ${fullPath}`, exact: true });
        await save.waitFor();
        const editor = page.locator(`[data-monaco-editor][data-monaco-state="ready"][data-path="${fullPath}"] .view-lines`);
        await editor.click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.evaluate(text => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", text);
          document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
        }, content);
        await save.click();
        await expect.poll(() => fixtureFiles.get(file)?.content).toBe(content);
        if (evidence) await page.screenshot({ path: join(evidence, capture) });
      };
      const refreshInventory = async () => {
        const previousReads = inventoryRequests.length;
        await sections.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect.poll(() => inventoryRequests.length).toBeGreaterThan(previousReads);
      };

      await returnTo(skills);
      await sections.getByRole("button", { name: "Add skill", exact: true }).click();
      await sections.getByLabel("Skill name").fill("migration-notes");
      await sections.getByRole("button", { name: "Create skill", exact: true }).click();
      await expect.poll(() => createRequests[0]?.content).toContain("name: migration-notes");
      await saveEdit(newSkillPath, "---\nname: migration-notes\ndescription: Record migrations.\n---\n\nDocument the rollback step.\n",
        "electron-project-skill-save.png");
      await returnTo(skills);
      await refreshInventory();
      await sections.getByRole("button", { name: `Open ${newSkillPath}`, exact: true }).waitFor();

      await returnTo(mcp);
      await sections.getByRole("button", { name: "Create .mcp.json", exact: true }).click();
      await expect.poll(() => createRequests[1]).toEqual({ file: mcpPath, content: '{"mcpServers":{}}\n' });
      await saveEdit(mcpPath, '{"mcpServers":{"fixture-docs":{"url":"https://example.invalid/mcp"}}}',
        "electron-project-mcp-save.png");
      await returnTo(mcp);
      await refreshInventory();
      await sections.getByText("fixture-docs", { exact: true }).waitFor();
      expect(await sections.getByText("https://example.invalid/mcp", { exact: false }).count()).toBe(0);
      if (evidence) await page.screenshot({ path: join(evidence, "electron-project-mcp-refreshed.png") });
      await sections.getByRole("button", { name: "Open MCP settings", exact: true }).click();
      await page.getByRole("heading", { name: "MCP servers", exact: true }).waitFor();
      expect(await page.getByText("fixture-docs", { exact: true }).filter({ visible: true }).count()).toBe(0);

      await returnTo(configFiles);
      await sections.getByRole("button", { name: "Create CLAUDE.md", exact: true }).click();
      await expect.poll(() => createRequests[2]).toEqual({ file: instructionPath, content: "# Project instructions\n" });
      await saveEdit(instructionPath, "# Atlas project instructions\n\nReview the changelog before a release.\n",
        "electron-project-instructions-save.png");
      await returnTo(configFiles);
      await refreshInventory();
      await sections.getByRole("button", { name: "Open CLAUDE.md", exact: true }).waitFor();

      expect(createRequests.map(({ file }) => file)).toEqual([newSkillPath, mcpPath, instructionPath]);
      expect(saveRequests).toEqual([newSkillPath, mcpPath, instructionPath]);
      expect(mcpMutations).toEqual([]);
    }

    await openProject("Harbor");
    await page.getByRole("button", { name: "Agent configuration", exact: true }).click();
    await page.getByText("harbor-check", { exact: true }).waitFor();
    if (!liveInventory) {
      expect(await sections.getByText("migration-notes", { exact: true }).count()).toBe(0);
      await mcp.click();
      await sections.getByRole("region", { name: "MCP", exact: true }).waitFor();
      for (const name of ["issue-tracker", "fixture-docs"]) {
        expect(await sections.getByText(name, { exact: true }).count()).toBe(0);
      }
      await configFiles.click();
      await sections.getByRole("button", { name: "Open AGENTS.override.md", exact: true }).waitFor();
      expect(await sections.getByRole("button", { name: "Open CLAUDE.md", exact: true }).count()).toBe(0);
    }
    expect(new Set(inventoryRequests)).toEqual(new Set(projects.map(project => project.id)));
  }, 75_000);
});
