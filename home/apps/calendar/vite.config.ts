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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react") || id.includes("/node_modules/react-dom") || id.includes("/node_modules/scheduler")) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
