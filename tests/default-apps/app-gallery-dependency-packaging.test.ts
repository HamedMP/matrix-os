import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("packages the gallery's portable starter without build-only dependencies", async () => {
  const script = await readFile("scripts/build-host-bundle.sh", "utf8");
  const cleanup = script.split("\n").find(line =>
    line.startsWith("find ") && line.includes("$STAGE_DIR/app/home") && line.includes("-name node_modules"),
  );
  expect(cleanup).toBeDefined();
  const stage = await mkdtemp(join(tmpdir(), "matrix-gallery-packaging-"));
  try {
    const app = join(stage, "app/home/apps/default");
    const starter = join(stage, "app/home/app-templates/connected-starter");
    for (const directory of [app, starter]) {
      await mkdir(join(directory, "node_modules"), { recursive: true });
      await mkdir(join(directory, "dist"));
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "node_modules/build-only"), "dependency");
      await writeFile(join(directory, "dist/index.html"), "compiled runtime");
      await writeFile(join(directory, "src/definition.json"), "{}");
      await writeFile(join(directory, "pnpm-lock.yaml"), "pinned dependencies");
    }
    // Execute the production staging rule, restricted to this test-owned tree.
    await execute("bash", ["-c", cleanup!], { env: { ...process.env, STAGE_DIR: stage }, timeout: 10_000 });
    for (const directory of [app, starter]) {
      await expect(access(join(directory, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(directory, "dist/index.html"), "utf8")).toBe("compiled runtime");
      expect(await readFile(join(directory, "src/definition.json"), "utf8")).toBe("{}");
      expect(await readFile(join(directory, "pnpm-lock.yaml"), "utf8")).toBe("pinned dependencies");
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
});
