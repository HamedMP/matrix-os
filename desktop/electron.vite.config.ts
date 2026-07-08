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
    plugins: [externalizeDepsPlugin()],
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
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // sandbox:true preloads must be CJS; ESM preloads require sandbox off.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
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
