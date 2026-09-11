import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createFileBlobRoutes } from "../../../../packages/gateway/src/file-blob-routes";
import { sanitizeProxyResponseHeaders } from "../../../../packages/platform/src/proxy-headers";
import { buildAppDomainProxyResponse } from "../../../../packages/platform/src/session-routing-proxy";
import { startStubGateway } from "./stub-gateway";

// Real Gateway attachment streaming over local HTTP. Only auth and the rest of
// the OS are fixtures; this does not claim live VPS or native-dialog UI coverage.
export async function startDownloadGateway() {
  const filename = "binary-fixture.bin";
  const size = 64 * 1024 * 1024 + 123;
  const homePath = await mkdtemp(join(tmpdir(), "matrix-large-download-"));
  const file = await open(join(homePath, filename), "wx");
  const hash = createHash("sha256");
  const chunk = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 256));
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const next = chunk.subarray(0, Math.min(chunk.length, size - offset));
      await file.writeFile(next);
      hash.update(next);
    }
  } finally { await file.close(); }
  const sha256 = hash.digest("hex");
  const stub = await startStubGateway({ rootFileEntries: [{ name: filename, type: "file", size, modified: "2026-09-11T00:00:00Z" }] });
  let requests = 0;
  let interruptNext = false;
  const app = new Hono();
  app.use("/api/files/*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer stub-token-1" && !c.req.header("cookie")?.includes("fixture-session=1")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (c.req.method === "GET") requests += 1;
    await next();
  });
  const files = new Hono().route("/api/files", createFileBlobRoutes({ homePath }));
  app.all("/api/files/*", async (c) => {
    const upstream = await files.fetch(c.req.raw);
    return buildAppDomainProxyResponse({ upstream, responseHeaders: sanitizeProxyResponseHeaders(upstream.headers), path: c.req.path, handle: "fixture", runtimeSlot: "primary", platformSecret: "fixture-secret" });
  });
  const gatewayRequire = createRequire(resolve(__dirname, "../../../../packages/gateway/package.json"));
  const { getRequestListener } = gatewayRequire("@hono/node-server") as typeof import("@hono/node-server");
  const handleFiles = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/download-review") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "fixture-session=1; HttpOnly; SameSite=Strict; Path=/" });
      res.end('<!doctype html><title>Download review</title><button id="download">Download</button><output id="status"></output>');
      return;
    }
    if (url.pathname === "/api/files/media" || url.pathname === "/api/files/blob") {
      if (req.method === "GET" && interruptNext) {
        interruptNext = false;
        let sent = 0;
        const originalWrite = res.write;
        res.write = function (...args: Parameters<typeof res.write>) {
          const result = originalWrite.apply(this, args);
          sent += Buffer.byteLength(args[0]);
          if (sent >= 2 * 1024 * 1024) {
            sent = -Infinity;
            setImmediate(() => res.destroy());
          }
          return result;
        };
      }
      void handleFiles(req, res);
      return;
    }
    const upstream = httpRequest(`${stub.url}${req.url ?? "/"}`, { method: req.method, headers: req.headers, timeout: 10_000 }, (response) => {
      res.writeHead(response.statusCode ?? 500, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("fixture timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`, filename, size, sha256,
    requestCount: () => requests,
    interruptNextDownload: () => { interruptNext = true; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await stub.close();
      await rm(homePath, { force: true, recursive: true });
    },
  };
}
