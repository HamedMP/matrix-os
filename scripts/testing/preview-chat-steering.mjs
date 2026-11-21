#!/usr/bin/env node
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

// Source renderer preview for the built-in browser. Gateway, storage, provider,
// and Clerk callbacks are fixtures; this does not qualify a deployed runtime.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/source-chat-composer.tsx"],
  bundle: true, write: false, outfile: "steering-preview.js", format: "iife", platform: "browser", jsx: "automatic",
  alias: { "@": join(root, "shell/src"), "@clerk/nextjs": join(root, "tests/e2e/fixtures/source-chat-clerk.ts") },
  define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" }, plugins: [{ name: "preview-react-dedupe", setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: requireDesktop.resolve(args.path) }));
  } }],
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!javascript) throw new Error("Steering preview bundle is empty");
const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
const css = tailwind.build(new Scanner({ sources: [
  { base: join(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
  { base: join(root, "shell/src"), pattern: "**/*.{ts,tsx}", negated: false },
] }).scan()) + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  response.setHeader("cache-control", "no-store");
  if (path === "/preview.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); return; }
  if (path === "/preview.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  if (path !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Chat steering source preview</title>
    <link rel="stylesheet" href="/preview.css"><style>
    :root{--text-primary:#222;--text-secondary:#666;--text-tertiary:#777;--bg-surface:#fff;--bg-overlay:#fff;--background:#fff;--bg-sunken:#eee;--border-subtle:#ddd;--accent:#3b5441;--text-on-accent:#fff}
    body{margin:0;font:14px Arial}#root{height:calc(100vh - 32px)}aside[aria-label="Preview limitation"]{height:32px;padding:6px 16px;background:#fef3c7}
    </style></head><body><aside aria-label="Preview limitation">Source renderer fixture · synthetic gateway, provider and sign-in · no deployment qualification</aside>
    <div id="root"></div><script src="/preview.js"></script></body></html>`);
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
console.log(`Chat steering preview: http://127.0.0.1:${server.address().port}/?steering=true`);
const stop = () => { clearTimeout(expiry); server.close(); server.closeAllConnections(); };
const expiry = setTimeout(stop, 30 * 60_000);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
