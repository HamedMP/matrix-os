import { expect, it } from "vitest";
import path from "node:path";
import { resolveConfig } from "vite";
it("resolves the rabbit mark from tracked source without a prior brand build", async () => {
  const config = await resolveConfig({
    configFile: path.resolve("tests/fixtures/aoede/ui-fixture/vite.config.ts"),
    logLevel: "silent",
  }, "serve");
  const resolveImport = config.createResolver();
  const imported = await resolveImport("@matrix-os/brand/marks",
    path.resolve("packages/ui/src/chat/ChatPresentation.tsx"));
  expect(imported).toBe(path.resolve("packages/brand/src/marks.ts"));
});
