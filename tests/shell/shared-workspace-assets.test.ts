import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readSharedBundledAsset } from "../../shell/src/app/workspace/bundled-assets";

afterEach(() => vi.unstubAllEnvs());
describe("runtime-independent shipped workspace assets", () => {
  it("serves actual shipped OS icons and bundled wallpaper", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_BUNDLE_ROOT", resolve("."));
    const icon = await readSharedBundledAsset(["icons", "files.png"], new URLSearchParams());
    expect(icon?.headers.get("content-type")).toBe("image/png");
    expect((await icon!.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const wallpaper = await readSharedBundledAsset(["api", "files", "blob"], new URLSearchParams({ path: "system/wallpapers/matrix-dusk.webp" }));
    expect(wallpaper?.headers.get("content-type")).toBe("image/webp");
    const surface = await readSharedBundledAsset(["system-app-icons", "v3", "canvas.png"], new URLSearchParams());
    expect(surface?.status).toBe(200);
  });
  it("serves the actual v2 built-in desktop icons without allowing arbitrary assets", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_BUNDLE_ROOT", resolve("."));
    for (const name of ["settings", "chat", "plugins", "terminal", "notes", "whiteboard", "files", "editor", "browser", "create-app", "launcher", "desktop", "canvas"]) {
      const response = await readSharedBundledAsset(["system-app-icons", "v2", `${name}.png`], new URLSearchParams());
      expect(response?.status, name).toBe(200);
      expect(response?.headers.get("content-type"), name).toBe("image/png");
    }
    expect(await readSharedBundledAsset(["system-app-icons", "v2", "uploaded.png"], new URLSearchParams())).toBeNull();
    expect(await readSharedBundledAsset(["system-app-icons", "v1", "settings.png"], new URLSearchParams())).toBeNull();
  });
  it("never serves owner files, arbitrary wallpaper names, or parent traversal", async () => {
    for (const path of ["system/soul.md", "system/wallpapers/uploaded.jpg", "system/icons/../../soul.md", "/etc/passwd"]) {
      expect(await readSharedBundledAsset(["api", "files", "blob"], new URLSearchParams({ path }))).toBeNull();
    }
    expect(await readSharedBundledAsset(["icons", "..", "soul.md"], new URLSearchParams())).toBeNull();
    expect(await readSharedBundledAsset(["icons", "../soul.svg"], new URLSearchParams())).toBeNull();
  });
  it("rejects symlink escapes from the immutable bundle roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-shared-assets-"));
    try {
      await mkdir(join(root, "home/system/icons"), { recursive: true });
      await writeFile(join(root, "private.svg"), "private");
      await symlink(join(root, "private.svg"), join(root, "home/system/icons/v3-files.svg"));
      vi.stubEnv("MATRIX_SHARED_WORKSPACE_BUNDLE_ROOT", root);
      expect(await readSharedBundledAsset(["icons", "v3-files.svg"], new URLSearchParams())).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
