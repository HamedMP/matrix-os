import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalActionTools } from "../../packages/gateway/src/chat/action-tools.js";
let home: string;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });
describe("bounded owner app tools", () => {
  it("lists valid Vite apps across missing, invalid and unsupported manifests", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-action-"));
    for (const app of ["alpha", "messages", "invalid", "static", "omega"]) await mkdir(join(home, "apps", app), { recursive: true });
    for (const app of ["alpha", "omega", "static"]) await writeFile(join(home, "apps", app, "matrix.json"), JSON.stringify({
      name: app, slug: app, version: "1.0.0", runtime: app === "static" ? "static" : "vite", runtimeVersion: "^24.0.0",
      build: { command: "vite build", output: "dist" },
    }));
    await writeFile(join(home, "apps/invalid/matrix.json"), "{broken");
    const tools = createCanonicalActionTools({ homeForOwner: async () => home });
    const input = { owner: { type: "personal" as const, ownerId: "tools_owner" }, actionId: "action_list", arguments: {}, signal: new AbortController().signal };
    expect(await tools[0].execute(input)).toEqual({ apps: [{ app: "alpha", name: "alpha" }, { app: "omega", name: "omega" }] });
    await expect(tools[1].execute({ ...input, arguments: { app: "messages" } })).rejects.toThrow();
    await expect(tools[1].execute({ ...input, arguments: { app: "static" } })).rejects.toThrow();
    await symlink(join(home, "apps/alpha/matrix.json"), join(home, "apps/messages/matrix.json"));
    await expect(tools[0].execute(input)).rejects.toThrow();
  });

  it("rejects secret/traversal paths before access and exposes one inventory", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-action-"));
    const tools = createCanonicalActionTools({ homeForOwner: async () => home });
    expect(tools.map((t) => t.toolId)).toEqual(["matrix_list_apps", "matrix_inspect_app", "matrix_search_workspace", "matrix_open_app", "matrix_apply_app_files"]);
    const apply = tools.find((t) => t.toolId === "matrix_apply_app_files")!;
    for (const path of ["../system/config.json", ".env", "src/auth.ts", "src/secrets.json", "node_modules/a.js"]) expect(() => apply.normalize({ app: "notes", files: [{ path, content: "bad", expectedSha256: null }] })).toThrow();
  });
  it("creates an approved valid Vite bundle without installing or running it and reconciles hashes", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-action-")); await mkdir(join(home, "apps"));
    const apply = createCanonicalActionTools({ homeForOwner: async () => home }).at(-1)!;
    const args = apply.normalize({ app: "notes", files: [
      { path: "matrix.json", content: JSON.stringify({ name: "Notes", slug: "notes", version: "1.0.0", runtime: "vite", runtimeVersion: "^24.0.0", build: { command: "pnpm exec vite build", output: "dist" }, permissions: [] }), expectedSha256: null },
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^7.0.0" } }), expectedSha256: null },
      { path: "index.html", content: '<div id="root"></div><script type="module" src="/src/main.tsx"></script>', expectedSha256: null },
      { path: "src/main.tsx", content: 'import React from "react";', expectedSha256: null },
    ] });
    const input = { owner: { type: "personal" as const, ownerId: "tools_owner" }, actionId: "action_create", arguments: args, signal: new AbortController().signal };
    expect(await apply.execute(input)).toMatchObject({ app: "notes", navigation: { path: "apps/notes" } });
    expect(await apply.reconcile!(input)).toMatchObject({ confirmed: true });
    await expect(apply.execute(input)).rejects.toThrow();
    expect(await readFile(join(home, "apps/notes/src/main.tsx"), "utf8")).toContain("React");
  });
  it("never follows symlinks", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-action-")); await mkdir(join(home, "apps"));
    await symlink(tmpdir(), join(home, "apps/notes"));
    const inspect = createCanonicalActionTools({ homeForOwner: async () => home }).find((t) => t.toolId === "matrix_inspect_app")!;
    await expect(inspect.execute({ owner: { type: "personal", ownerId: "tools_owner" }, actionId: "action_inspect", arguments: inspect.normalize({ app: "notes" }), signal: new AbortController().signal })).rejects.toThrow();
  });
});
