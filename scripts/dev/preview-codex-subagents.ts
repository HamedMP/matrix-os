/** Local-only preview of the production shared row, with synthetic review data. */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, "../..");
const desktopRequire = createRequire(resolve(root, "desktop/package.json"));
const { createServer } = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
const { default: tailwindcss } = await import(pathToFileURL(desktopRequire.resolve("@tailwindcss/vite")).href);
const server = await createServer({
  configFile: false, root: resolve(root, "scripts/dev/subagent-preview"), plugins: [tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"], alias: {
    react: resolve(root, "desktop/node_modules/react"), "react-dom": resolve(root, "desktop/node_modules/react-dom"),
  } },
  server: { host: "127.0.0.1", port: 5187, strictPort: true, fs: { allow: [root] } },
});
try {
  await server.listen(); server.printUrls();
  await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
} finally { await server.close(); }
