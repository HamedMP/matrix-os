import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shellRequire } from "./shell-require.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, "../../..");
export default defineConfig({ root, publicDir: resolve(repository, "home/apps/app-gallery/public"),
  esbuild: { jsx: "automatic" }, resolve: { alias: { "@": resolve(repository, "shell/src"), "tailwindcss": shellRequire.resolve("tailwindcss/index.css") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 3052, strictPort: true, fs: { allow: [repository] } },
});
