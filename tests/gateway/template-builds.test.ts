import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { BuildOrchestrator } from "../../packages/gateway/src/app-runtime/build-orchestrator.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

describe("Vite template build", () => {
  it("builds template-vite to dist/ with expected content", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-template-build-"));
    // Copy to a valid slug directory name
    const appDir = join(tmpDir, "myapp");
    await cp(
      join(process.cwd(), "home/apps/_template-vite"),
      appDir,
      { recursive: true, filter: (source) => !["node_modules", "dist", ".build.log", ".build-stamp.json"].includes(basename(source)) },
    );
    // Fix slug to match directory name and use non-frozen install
    const manifestPath = join(appDir, "matrix.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.slug = "myapp";
    manifest.build.install = "pnpm install";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const orch = new BuildOrchestrator({
      concurrency: 2,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    const result = await orch.build("myapp", appDir);
    // Preserve the real install/build stage and bounded command output in CI
    // before afterEach removes the disposable app and its .build.log.
    if (!result.ok) throw result.error;
    expect(result.ok).toBe(true);

    const indexPath = join(appDir, "dist", "index.html");
    expect(existsSync(indexPath)).toBe(true);

    const html = await readFile(indexPath, "utf8");
    expect(html).toContain("<html");
    expect(html).toContain("<script");
  }, 120_000);
});
