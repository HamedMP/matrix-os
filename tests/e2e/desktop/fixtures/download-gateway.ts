import { createServer, request as httpRequest } from "node:http";
import { startStubGateway } from "./stub-gateway";

// Local HTTP fixture: real main-process fetch + filesystem I/O, with synthetic
// auth/data. Deliberately does not claim live VPS or native-dialog UI coverage.
export async function startDownloadGateway() {
  const filename = "binary-fixture.zip";
  const bytes = Buffer.from(Array.from({ length: 65_536 }, (_, i) => i % 256));
  const stub = await startStubGateway({ rootFileEntries: [{ name: filename, type: "file", size: bytes.length, modified: "2026-09-11T00:00:00Z" }] });
  let requests = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/files/blob") {
      if (req.headers.authorization !== "Bearer stub-token-1") { res.writeHead(401); res.end(); return; }
      if (url.searchParams.get("path") !== filename) { res.writeHead(404); res.end(); return; }
      requests += 1;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) });
      res.end(bytes);
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
    url: `http://127.0.0.1:${address.port}`, filename, bytes,
    requestCount: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await stub.close();
    },
  };
}
