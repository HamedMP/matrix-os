import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const desktopUpdateChannel =
  process.env.MATRIX_DESKTOP_UPDATE_CHANNEL || process.env.OPERATOR_UPDATE_CHANNEL || "";
const codingAgentsDesktopWorkspace =
  process.env.VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0";

export default defineConfig({
  main: {
    // Workspace contracts export TypeScript source for package consumers.
    // Bundle the schemas and Zod so the built Electron main process never
    // depends on source-only `.js` specifiers at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ["zod", "@matrix-os/contracts", "@finnaai/matrix"] })],
    define: {
      __MATRIX_DESKTOP_UPDATE_CHANNEL__: JSON.stringify(desktopUpdateChannel),
      __CODING_AGENTS_DESKTOP_WORKSPACE__: JSON.stringify(codingAgentsDesktopWorkspace),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    // Sandboxed preloads cannot require external packages — bundle everything
    // needed for contract validation except the electron builtin.
    plugins: [externalizeDepsPlugin({ exclude: ["zod", "@matrix-os/contracts"] })],
    build: {
      rollupOptions: {
        // A sandboxed Electron preload cannot require sibling files. Keep the
        // shell and app bridge behind one entry so Rollup emits no shared
        // chunks that Chromium's restricted preload loader cannot resolve.
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Reuse the web terminal's canonical agent logos so Desktop and web never
    // drift to different provider artwork.
    publicDir: resolve(__dirname, "../shell/public"),
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
