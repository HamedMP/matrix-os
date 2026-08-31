import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("terminal workspace store", () => {
  it("makes workspace state and background scrollback renames directory-durable", async () => {
    const source = await readFile(
      join(process.cwd(), "packages/terminal-runtime/src/workspace-store.ts"),
      "utf8",
    );
    expect(source).toContain("await writeTextAtomic(this.statePath");
    expect(source).toContain("await writeTextAtomic(target, content)");
    expect(source).toContain('const directoryHandle = await open(dirname(path), "r")');
    expect(source).toContain("await directoryHandle.sync()");
    expect(source).toContain("await rm(temporaryPath, { force: true })");
  });

  it("enforces one durable workspace per project and one reserved main workspace", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-workspaces-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });

    const main = await store.ensureWorkspace();
    const firstProject = await store.ensureWorkspace({ projectId: "matrix-os" });
    const sameProject = await store.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await store.createTab(firstProject.id, { name: "tests", cwd: "projects/matrix-os" });

    expect(main.scope).toBe("main");
    expect(sameProject.id).toBe(firstProject.id);
    expect(tab.workspaceId).toBe(firstProject.id);
    expect((await store.listWorkspaces()).map((workspace) => workspace.id)).toEqual([main.id, firstProject.id]);

    const restarted = new TerminalWorkspaceStore({ homePath });
    expect((await restarted.getTab({ workspaceId: firstProject.id, tabId: tab.id }))?.name).toBe("tests");

    const persisted = JSON.parse(await readFile(join(homePath, "system", "terminal-workspaces.json"), "utf8"));
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.workspaces[firstProject.id].zellijSessionName).toMatch(/^matrix-w-[0-9a-f]{32}$/);
    expect(persisted.workspaces[firstProject.id].tabs[tab.id].zellijTabName).toMatch(/^matrix-tab-[0-9a-f]{32}$/);
    expect(JSON.stringify(await store.listWorkspaces())).not.toContain("zellij");
  });

  it("persists a control-heavy snapshot at the public ANSI limit", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-snapshot-capacity-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const workspace = await store.ensureWorkspace();
    const tab = await store.createTab(workspace.id, { name: "capacity", cwd: "" });
    const ansi = "\u0001".repeat(5 * 1024 * 1024);
    const scrollback = Array.from(
      { length: Math.ceil(ansi.length / 16_384) },
      (_, index) => ansi.slice(index * 16_384, (index + 1) * 16_384),
    );

    await expect(store.importSnapshot(
      { workspaceId: workspace.id, tabId: tab.id },
      { ansi, viewport: [], scrollback, seq: 1 },
    )).resolves.toMatchObject({ ansi, scrollback, seq: 1 });
    await expect(store.readSnapshot({ workspaceId: workspace.id, tabId: tab.id }))
      .resolves.toMatchObject({ ansi, scrollback, seq: 1 });
  });
});
