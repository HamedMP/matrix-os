import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutStore } from "../../packages/gateway/src/shell/layouts.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-layouts-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("layout store", () => {
  it("saves valid layouts atomically and lists metadata", async () => {
    const root = await tempRoot();
    const adapter = { validateLayout: vi.fn(async () => undefined) };
    const store = new LayoutStore({ homePath: root, adapter, maxBytes: 100 });

    await store.save("dev", "layout { }");

    await expect(store.show("dev")).resolves.toEqual({ name: "dev", kdl: "layout { }" });
    const layouts = await store.list();
    expect(layouts).toHaveLength(1);
    expect(layouts[0].name).toBe("dev");
  });

  it("rejects oversized layouts before validation", async () => {
    const root = await tempRoot();
    const adapter = { validateLayout: vi.fn(async () => undefined) };
    const store = new LayoutStore({ homePath: root, adapter, maxBytes: 4 });

    await expect(store.save("dev", "layout { }")).rejects.toMatchObject({
      code: "layout_too_large",
    });
    expect(adapter.validateLayout).not.toHaveBeenCalled();
  });

  it("cleans temp files and preserves the previous layout when validation fails", async () => {
    const root = await tempRoot();
    const layoutsDir = join(root, "system", "layouts");
    await writeFile(join(layoutsDir, "dev.kdl"), "old", { flag: "wx" }).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await import("node:fs/promises").then(({ mkdir }) => mkdir(layoutsDir, { recursive: true }));
      await writeFile(join(layoutsDir, "dev.kdl"), "old", { flag: "wx" });
    });
    const adapter = { validateLayout: vi.fn(async () => { throw new Error("bad"); }) };
    const store = new LayoutStore({ homePath: root, adapter, maxBytes: 100 });

    await expect(store.save("dev", "new")).rejects.toMatchObject({ code: "invalid_layout" });
    await expect(readFile(join(layoutsDir, "dev.kdl"), "utf-8")).resolves.toBe("old");
    const files = await readdir(layoutsDir);
    expect(files.filter((file) => file.includes(".tmp-"))).toEqual([]);
  });
});
