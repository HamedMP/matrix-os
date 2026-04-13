import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "3000", 10);

const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/hello" || req.url?.startsWith("/api/hello?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "hello from next" }));
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>Hello Next</body></html>");
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  // Server ready
});
