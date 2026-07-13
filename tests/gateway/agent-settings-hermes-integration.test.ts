import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSettingsViewSchema } from "@matrix-os/contracts";
import { Hono } from "hono";
import {
  createHermesDashboardClient,
} from "../../packages/gateway/src/agent-config/hermes-client.js";
import {
  createHermesRuntimeSource,
} from "../../packages/gateway/src/agent-config/hermes-source.js";
import { createSettingsRoutes } from "../../packages/gateway/src/routes/settings.js";

describe("unified agent settings Hermes integration", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("renders the live loopback inventory through the public settings route", async () => {
    const homePath = mkdtempSync(join(tmpdir(), "agent-settings-hermes-"));
    cleanupPaths.push(homePath);
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system/config.json"), "{}");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/status") {
        return Response.json({ version: "1.0.0", gateway_running: true });
      }
      return Response.json({
        provider: "nous",
        model: "hermes-4-405b",
        providers: [{
          slug: "nous",
          name: "Nous Portal",
          authenticated: true,
          auth_type: "oauth",
          models: ["hermes-4-405b"],
        }],
      });
    });
    const hermesClient = createHermesDashboardClient({
      baseUrl: "http://127.0.0.1:9119",
      fetchImpl,
    });
    const routes = createSettingsRoutes({
      homePath,
      channelManager: {
        status: () => ({}),
        start: async () => {},
        stop: async () => {},
        send: () => {},
        replay: async () => {},
        restartChannel: async () => {},
      } as never,
      agentRuntimeSource: createHermesRuntimeSource(hermesClient.readJson),
    });
    const app = new Hono();
    app.route("/api/settings", routes);

    const response = await app.request("/api/settings/agent");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(AgentSettingsViewSchema.safeParse(body).success).toBe(true);
    expect(body.currentSelection.messaging).toEqual({
      runtime: "hermes",
      provider: "nous",
      model: "hermes-4-405b",
      configured: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
