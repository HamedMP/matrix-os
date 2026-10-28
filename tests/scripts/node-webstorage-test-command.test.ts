import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("runs every repository Vitest entrypoint without Node experimental web storage", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["test", "test:watch", "test:integration", "test:coverage", "test:e2e", "test:e2e:run"]) {
    expect(manifest.scripts[name], name).toContain("--no-experimental-webstorage");
    expect(manifest.scripts[name], name).toContain("node node_modules/vitest/vitest.mjs");
  }
});
