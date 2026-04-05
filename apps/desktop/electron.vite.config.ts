import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { resolve } from "node:path"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        external: ["electron", "electron-updater", "electron-store", "@electron-toolkit/utils", "@electron-toolkit/preload"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: {
        entry: {
          index: resolve(__dirname, "src/preload/index.ts"),
          "chrome-preload": resolve(__dirname, "src/preload/chrome-preload.ts"),
        },
        formats: ["cjs"],
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
})
