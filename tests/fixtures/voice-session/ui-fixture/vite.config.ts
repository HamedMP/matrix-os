import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = path.resolve(fixtureRoot, "../../../..");

export default defineConfig({
  root: fixtureRoot,
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
});
