import { expect, it } from "vitest";
import { build, loadConfigFromFile } from "vite";
import { resolve } from "node:path";

it("bundles one React runtime for Electron and shared Chat components", async () => {
  const config = await loadConfigFromFile({ command: "build", mode: "production" }, resolve("desktop/electron.vite.config.ts"));
  const entry = resolve("desktop/src/renderer/src/react-runtime-fixture.tsx");
  const runtimes: string[] = [];
  await build({ ...config!.config.renderer, configFile: false, root: resolve("desktop"), logLevel: "silent", plugins: [...config!.config.renderer.plugins, {
    name: "chat-runtime-fixture",
    resolveId(id) { if (id === entry) return entry; },
    load(id) { if (id === entry) return 'export { useState } from "react"; export { ChatSharingButton } from "@matrix-os/ui";'; },
    generateBundle() {
      for (const id of this.getModuleIds()) if (!id.startsWith("\0") && /\/react\/cjs\/react.production.js$/.test(id)) runtimes.push(id);
    },
  }], build: { write: false, minify: false, lib: { entry, formats: ["es"] }, rollupOptions: { external: [] } } });
  expect(runtimes).toHaveLength(1);
});
