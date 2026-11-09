/** Loopback-only shared component preview; optional content-free export stays outside git. */
import { createServer } from "vite";
import {
  scanUsageRoots,
  usageRoots,
} from "../../packages/contracts/src/ai-usage/node.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const server = await createServer({
  root: resolve(import.meta.dirname),
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: 3410,
    strictPort: true,
    fs: { allow: [root] },
  },
  resolve: {
    alias: {
      "@matrix-os/contracts/ai-usage": resolve(
        root,
        "packages/contracts/src/ai-usage/index.ts",
      ),
    },
  },
  plugins: [
    {
      name: "private-usage-snapshot",
      configureServer(server) {
        let pending = null;
        server.middlewares.use("/api/ai-usage", async (req, res) => {
          try {
            if (req.method !== "GET" || (req.url !== "/" && req.url !== "")) {
              res.statusCode = 400;
              res.end("{}");
              return;
            }
            const task =
              pending ??
              (process.env.AI_USAGE_PREVIEW_REPORT ? readFile(process.env.AI_USAGE_PREVIEW_REPORT, "utf8").then(JSON.parse) : scanUsageRoots(
                usageRoots(process.env.AI_USAGE_PREVIEW_HOME ?? homedir()),
                AbortSignal.timeout(60_000),
              ));
            pending = task;
            try {
              const value = await task;
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify(value));
            } finally {
              if (pending === task) pending = null;
            }
          } catch (error) {
            console.warn(
              "Usage preview unavailable",
              error instanceof Error ? error.name : "UnknownError",
            );
            res.statusCode = 503;
            res.end("{}");
          }
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
