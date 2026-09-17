import { createServer, request } from "node:http";
import { connect } from "node:net";
import { startStubGateway } from "./stub-gateway";
import { providerAuthActions } from "../../../../packages/gateway/src/coding-agents/provider-auth-actions";
import type { AgentProviderSummary } from "@matrix-os/contracts";

/** Isolated provider fixture; no real provider login/logout is executed. */
export async function startProviderAuthGateway() {
  const upstream = await startStubGateway();
  let authenticated = false;
  const commands: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/api/coding-agents/summary") {
      const response = await fetch(`${upstream.url}${req.url}`, {
        headers: { authorization: req.headers.authorization ?? "" }, signal: AbortSignal.timeout(10_000),
      });
      const summary = await response.json() as { providers: AgentProviderSummary[] };
      const provider: AgentProviderSummary = {
        id: "claude", kind: "claude", displayName: "Claude", installStatus: "installed",
        authStatus: authenticated ? "authenticated" : "missing",
        availability: authenticated ? "available" : "auth_required",
        supportedModes: ["default"], defaultMode: "default",
        setupActions: [{ id: "claude_connect", kind: "foreground_terminal", label: "Connect Claude", command: "claude auth login" }],
      };
      provider.setupActions = providerAuthActions(provider);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...summary, providers: [provider] }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/tabs")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      commands.push(JSON.parse(body.toString()));
      const forward = request(`${upstream.url}${req.url}`, { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      forward.on("error", () => { res.writeHead(502); res.end(); });
      forward.end(body);
      return;
    }
    const forward = request(`${upstream.url}${req.url}`, { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    forward.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  server.on("upgrade", (req, socket, head) => {
    const target = connect(upstream.port, "127.0.0.1", () => {
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
    socket.on("close", () => target.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`, commands,
    setAuthenticated(value: boolean) { authenticated = value; },
    async close() { server.closeAllConnections(); await upstream.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
