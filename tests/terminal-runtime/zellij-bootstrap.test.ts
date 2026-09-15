import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeMatrixZellijConfig } from "../../packages/terminal-runtime/src/zellij-bootstrap.js";
import { matrixZellijConfigPaths } from "../../packages/gateway/src/shell/zellij-config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function freshHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-zellij-bootstrap-"));
  roots.push(root);
  return root;
}

describe("terminal runtime Zellij bootstrap", () => {
  it("initializes config and every shell/layout dependency in a clean home", async () => {
    const home = await freshHome();
    const paths = matrixZellijConfigPaths(home);
    await initializeMatrixZellijConfig(home);
    const config = await readFile(paths.file, "utf8");
    expect(config).toContain(`default_shell ${JSON.stringify(paths.shellFile)}`);
    expect(config).toContain('default_layout "matrix"');
    for (const file of [paths.shellFile, paths.zshenvFile, paths.zshrcFile, paths.bashrcFile, paths.promptLabelFile, paths.layoutFile]) {
      expect((await readFile(file, "utf8")).length).toBeGreaterThan(0);
    }
    expect((await stat(paths.shellFile)).mode & 0o777).toBe(0o700);
    expect((await readFile(paths.shellFile, "utf8"))).toContain(paths.bashrcFile);
    expect(await readdir(paths.dir)).not.toContain(expect.stringMatching(/^\.bootstrap-/));
  });

  it("preserves existing owner configuration and repairs missing dependencies on repeated startup", async () => {
    const home = await freshHome();
    const paths = matrixZellijConfigPaths(home);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.file, 'theme "gruvbox-light"\n');
    await writeFile(paths.bashrcFile, "# owner terminal customizations\n");
    await initializeMatrixZellijConfig(home);
    await unlink(paths.layoutFile);
    await initializeMatrixZellijConfig(home);
    expect(await readFile(paths.file, "utf8")).toBe('theme "gruvbox-light"\n');
    expect(await readFile(paths.bashrcFile, "utf8")).toBe("# owner terminal customizations\n");
    expect(await readFile(paths.layoutFile, "utf8")).toContain("layout {");
  });

  it("publishes complete assets without overwriting when initializers run concurrently", async () => {
    const home = await freshHome();
    await Promise.all(Array.from({ length: 8 }, () => initializeMatrixZellijConfig(home)));
    const paths = matrixZellijConfigPaths(home);
    expect(await readFile(paths.file, "utf8")).toContain('default_mode "locked"');
    expect((await readdir(paths.dir)).filter((name) => name.startsWith(".bootstrap-"))).toEqual([]);
  });

  it.each(["system", "system/zellij", "system/zellij/layouts", "system/zellij/config.kdl"])(
    "rejects symlinked %s without writing outside the home", async (relativePath) => {
      const home = await freshHome();
      const outside = await freshHome();
      const target = join(home, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await symlink(outside, target);
      await expect(initializeMatrixZellijConfig(home)).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
      const paths = matrixZellijConfigPaths(home);
      expect((await readdir(paths.dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).filter((name) => name.startsWith(".bootstrap-"))).toEqual([]);
    },
  );
});
