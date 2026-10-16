import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

it("bundles one React runtime for Electron and shared Chat components", () => {
  // This in-memory fixture does not publish an artifact. Isolate release-only
  // provenance assertions without mutating the worker's environment or guard.
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
  import { resolve } from "node:path";
  const { build, loadConfigFromFile } = await import("vite");
  const config = await loadConfigFromFile({ command: "build", mode: "production" }, resolve("desktop/electron.vite.config.ts"));
  const entry = resolve("desktop/src/renderer/src/react-runtime-fixture.tsx");
  const runtimes = [];
  await build({ ...config.config.renderer, configFile: false, root: resolve("desktop"), logLevel: "silent", plugins: [...config.config.renderer.plugins, {
    name: "chat-runtime-fixture",
    resolveId(id) { if (id === entry) return entry; },
    load(id) { if (id === entry) return 'export { useState } from "react"; export { ChatSharingButton } from "@matrix-os/ui";'; },
    generateBundle() {
      for (const id of this.getModuleIds()) if (!id.startsWith("\\0") && /\\/react\\/cjs\\/react.production.js$/.test(id)) runtimes.push(id);
    },
  }], build: { write: false, minify: false, lib: { entry, formats: ["es"] }, rollupOptions: { external: [] } } });
  console.log(JSON.stringify(runtimes));
  `], { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, stdio: "pipe" });
  expect(JSON.parse(output)).toHaveLength(1);
}, 35_000);
