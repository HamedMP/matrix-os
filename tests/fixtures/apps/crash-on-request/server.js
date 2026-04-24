import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "3000", 10);
let requestCount = 0;

const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  requestCount++;

  // Serve the first non-health request, then crash
  if (requestCount === 1) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ served: true, count: requestCount }));
    // Crash after responding
    setTimeout(() => process.exit(1), 50);
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ served: true, count: requestCount }));
});

server.listen(port, "127.0.0.1", () => {
  // Server ready
});
