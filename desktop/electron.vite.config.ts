import { defineConfig, externalizeDepsPlugin, type UserConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { searchForWorkspaceRoot } from "vite";
import { DESKTOP_DEV_RENDERER_HOST } from "./src/main/renderer-url";
import { readBuildSource } from "../scripts/release/build-source.mjs";

// pnpm's global virtual store links packages from outside the checkout, and
// the dev server refuses to serve files there. Allow only the renderer's font
// packages so dev renders Geist/Inter instead of silently falling back.
const RENDERER_FONT_PACKAGES = [
  "@expo-google-fonts/geist",
  "@expo-google-fonts/bricolage-grotesque",
  "@fontsource/inter",
  "@fontsource/jetbrains-mono",
  "@fontsource/instrument-sans",
  "@fontsource/instrument-serif",
];

function rendererFontPackageDirs(): string[] {
  return RENDERER_FONT_PACKAGES.flatMap((name) => {
    try {
      return [realpathSync(resolve(__dirname, "node_modules", name))];
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
}

const desktopUpdateChannel =
  process.env.MATRIX_DESKTOP_UPDATE_CHANNEL || process.env.OPERATOR_UPDATE_CHANNEL || "";
const codingAgentsDesktopWorkspace =
  process.env.VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0";

// Evaluate after electron-vite removes its temporary bundled config file, so
// that generated file cannot make the source checkout appear uncommitted.
export default defineConfig((): UserConfig => ({
  main: {
    // Workspace contracts and the collaboration direct client export TypeScript
    // source. Bundle them so Electron never loads raw TypeScript at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ["zod", "@matrix-os/contracts", "@matrix-os/ui", "@finnaai/matrix"] })],
    define: {
      __MATRIX_DESKTOP_BUILD_SOURCE__: JSON.stringify(readBuildSource(resolve(__dirname, ".."), process.env.GITHUB_SHA)),
      __MATRIX_DESKTOP_UPDATE_CHANNEL__: JSON.stringify(desktopUpdateChannel),
      __CODING_AGENTS_DESKTOP_WORKSPACE__: JSON.stringify(codingAgentsDesktopWorkspace),
    },
    build: {
      rollupOptions: {
        // Electron is a runtime builtin; bundling its npm installer breaks startup.
        external: ["electron"],
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
        external: ["electron"],
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
      allowedHosts: [DESKTOP_DEV_RENDERER_HOST],
      fs: { allow: [searchForWorkspaceRoot(__dirname), ...rendererFontPackageDirs()] },
    },
    resolve: {
      // Global-store peers can resolve separate React/Lexical copies. Hooks and
      // custom editor nodes must share their renderer runtime's class identity.
      dedupe: ["react", "react-dom", "lexical"],
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
}));
