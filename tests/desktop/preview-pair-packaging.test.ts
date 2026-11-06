import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
it("the actual pair packager overrides inherited global protocols and ordinary bundle identity", async () => {
  const workflow = parse(readFileSync(".github/workflows/desktop-build.yml", "utf8"));
  const step = workflow.jobs.pair_artifacts.steps.find((value: { name?: string }) => value.name === "Package unsigned portable app");
  const file = step.run.includes("preview-electron-builder.yml") ? "preview-electron-builder.yml" : "electron-builder.yml";
  const require = createRequire(createRequire(resolve("desktop/package.json")).resolve("electron-builder"));
  const { getConfig } = require("app-builder-lib/out/util/config/config.js");
  const config = await getConfig(resolve("desktop"), resolve("desktop", file));
  expect(config.protocols ?? []).toEqual([]); expect(config.appId).toBe("com.matrix-os.preview-pair");
  expect(config.generateUpdatesFilesForAllChannels).toBe(false);
  expect(step.run).toContain('--config "$GITHUB_WORKSPACE/controller/desktop/preview-electron-builder.yml"');
});
