import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shellRequire } from "./shell-require.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, "../../..");

export default defineConfig({
  root,
  publicDir: resolve(repository, "home/apps/app-gallery/public"),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@matrix-os/brand/boot-screen": resolve(repository, "packages/brand/src/boot-screen.ts"),
      "@matrix-os/brand/tokens": resolve(repository, "packages/brand/src/tokens.ts"),
      "@matrix-os/brand/marks": resolve(repository, "packages/brand/src/marks.ts"),
      "@matrix-os/brand": resolve(repository, "packages/brand/src/index.ts"),
      "@": resolve(repository, "shell/src"),
      "tailwindcss": shellRequire.resolve("tailwindcss/index.css"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: { host: "127.0.0.1", port: 3052, strictPort: true, fs: { allow: [repository] } },
});
