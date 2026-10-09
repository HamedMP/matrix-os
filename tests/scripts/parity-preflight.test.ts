import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { runPreflight } from "../../scripts/dev-preflight.mjs";
import { waitForParityRoute } from "../../scripts/local-production-parity/recovery.mjs";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

async function healthServer(status: string) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/health`, requests };
}

it("reports a healthy non-Aoede environment without Chat, Codex or paid provider calls", async () => {
  const server = await healthServer("ok");
  const result = await runPreflight({ platformUrl: server.url, command: async () => true,
    authenticatedGet: async (path: string) => {
      if (path === "/api/integrations/available") return { status: 503, json: { error: "integrations_unavailable" } };
      if (path === "/api/integrations/capabilities") return { status: 200, json: {} };
      throw new Error("Unrequested provider or Chat operation");
    } });
  expect(result.exitCode).toBe(0);
  expect(result.checks.find((check: { id: string }) => check.id === "integrations")?.level).toBe("WARN");
  expect(server.requests).toEqual(["GET /health"]);
});

it("cannot report ready when platform returns HTTP 200 but is not healthy or owner auth is rejected", async () => {
  const server = await healthServer("starting");
  const result = await runPreflight({ platformUrl: server.url, command: async () => true,
    authenticatedGet: async () => ({ status: 401 }) });
  expect(result.exitCode).toBe(1);
  expect(result.checks.filter((check: { level: string }) => check.level === "FAIL").map((check: { id: string }) => check.id))
    .toEqual(["platform-health", "capabilities"]);
});

it("fails a required transport check even if all API probes succeed", async () => {
  const server = await healthServer("ok");
  const result = await runPreflight({ platformUrl: server.url, command: async (id: string) => id !== "storage-tls",
    authenticatedGet: async () => ({ status: 200, json: {} }) });
  expect(result.exitCode).toBe(1);
  expect(result.checks.filter((check: { level: string }) => check.level === "FAIL").map((check: { id: string }) => check.id))
    .toEqual(["storage-tls"]);
});

it("cannot report ready when host health succeeds but the platform-to-VM route is unreachable", async () => {
  const server = await healthServer("ok");
  const result = await runPreflight({ platformUrl: server.url,
    command: async (id: string) => id !== "routed-health",
    authenticatedGet: async () => ({ status: 200, json: {} }) });
  expect(result.exitCode).toBe(1);
  expect(result.checks.filter((check: { level: string }) => check.level === "FAIL").map((check: { id: string }) => check.id))
    .toEqual(["routed-health"]);
  expect(server.requests).toEqual(["GET /health"]);
});

it("rejects HTTP success without gateway readiness on the actual routed health contract", async () => {
  const server = await healthServer("starting");
  await expect(waitForParityRoute((_url: string, options: RequestInit) => fetch(server.url, options), async () => {}, 2))
    .rejects.toThrow();
  expect(server.requests).toEqual(["GET /health", "GET /health"]);
});
