import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = path.resolve(fixtureRoot, "../../../..");
const uiSrc = path.join(repositoryRoot, "packages/ui/src");
const contractsSrc = path.join(repositoryRoot, "packages/contracts/src");
const shellSrc = path.join(repositoryRoot, "shell/src");

// Standalone Aoede fixture: renders the real ShellAoedeHost (singleton
// launcher + command-palette entry + panel) inside a vite page. `@` maps into
// shell/src so the genuine host module is exercised; `@matrix-os/*` aliases
// point straight at workspace sources so the fixture resolves without a build
// step. Only faked seams are the fetcher + voiceFactory injected as props.
export default defineConfig(({ mode }) => ({
  root: fixtureRoot,
  plugins: [react(), tailwindcss()],
  define: {
    // Shell modules reference process.env inside function bodies only; keep a
    // stub so no code path trips on a missing global in the browser build.
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
    "process.env": "{}",
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "@matrix-os/brand/tokens", replacement: path.join(repositoryRoot, "packages/brand/src/tokens.ts") },
      { find: "@matrix-os/brand/marks", replacement: path.join(repositoryRoot, "packages/brand/src/marks.ts") },
      // Contract subpath exports map onto same-named source files.
      { find: /^@matrix-os\/contracts\/(.+)$/, replacement: `${contractsSrc}/$1` },
      { find: "@matrix-os/contracts", replacement: path.join(contractsSrc, "index.ts") },
      // UI export-map renames that do not map 1:1 onto the src tree.
      { find: "@matrix-os/ui/aoede.css", replacement: path.join(uiSrc, "aoede/aoede-panel.css") },
      { find: "@matrix-os/ui/voice-session.css", replacement: path.join(uiSrc, "voice-session/voice-session.css") },
      { find: "@matrix-os/ui/agents-providers.css", replacement: path.join(uiSrc, "agents-providers/agents-providers.css") },
      { find: "@matrix-os/ui/chat-agents.css", replacement: path.join(uiSrc, "chat-agents/chat-agents.css") },
      { find: "@matrix-os/ui/styles.css", replacement: path.join(uiSrc, "styles.css") },
      { find: "@matrix-os/ui/shell-layering", replacement: path.join(uiSrc, "shell-layering.ts") },
      { find: "@matrix-os/ui/aoede", replacement: path.join(uiSrc, "aoede/index.ts") },
      // Bare specifier only needs window placement helpers for the pulled shell
      // graph (useWindowManager); the full barrel would drag every component in.
      { find: "@matrix-os/ui", replacement: path.join(fixtureRoot, "src/ui-barrel-shim.ts") },
      { find: "@", replacement: shellSrc },
    ],
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
}));
