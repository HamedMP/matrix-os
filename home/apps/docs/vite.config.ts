import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    // Shared office sources under ../_shared must use this app's single React copy.
    dedupe: ["react", "react-dom"],
  },
  server: {
    fs: { allow: [".."] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The single file below is deliberate, so Vite's advice to code-split over 500 kB does not apply.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // One JavaScript file: the app frame is sandboxed with a null origin, which refuses a
        // module chunk fetched later, so nothing may be split off (tests/default-apps/single-chunk.ts).
        inlineDynamicImports: true,
      },
    },
  },
});
