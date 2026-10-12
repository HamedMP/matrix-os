import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep header artwork self-contained in sandboxed Electron and web apps.
    assetsInlineLimit: (filePath) => filePath.endsWith("/v3-resource-manager.png") ? true : undefined,
  },
});
