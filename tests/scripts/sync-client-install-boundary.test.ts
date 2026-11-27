import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

// Electron 42+ fetches its binary on first launch, never during install
// (ELECTRON_SKIP_BINARY_DOWNLOAD is no longer honoured). The Node 20 lane stays
// binary-free only while the pinned package has no install lifecycle script.
it("installs the Node 20 sync-client lane without downloading an unused desktop binary", () => {
  const job = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs["sync-client"];
  const install = job.steps.find((step: { run?: string }) => step.run === "pnpm install --frozen-lockfile");
  expect(install).toBeDefined();
  expect(job.steps.some((step: { with?: { [key: string]: unknown } }) => step.with?.["node-version"] === 20)).toBe(true);

  const desktopRequire = createRequire(join(process.cwd(), "desktop/package.json"));
  const electron = JSON.parse(readFileSync(desktopRequire.resolve("electron/package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const hook of ["preinstall", "install", "postinstall"]) {
    expect(electron.scripts?.[hook], `electron ${hook} script`).toBeUndefined();
  }
});
