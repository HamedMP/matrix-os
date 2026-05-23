import { describe, expect, it } from "vitest";
import { createAgentCredentialRoutes } from "../../packages/gateway/src/onboarding/agent-credential-routes.js";
import { createAgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function post(path: string, body: unknown = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agent credential status routes", () => {
  it("keeps Hermes active when Claude and Codex are missing", async () => {
    const service = createAgentCredentialStatusService();
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("/credentials/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemAgent).toBe("hermes");
    expect(body.activeAgents).toEqual(["hermes"]);
    expect(body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "hermes", status: "available", coordinationRole: "system_agent" }),
      expect.objectContaining({ agent: "claude", status: "missing", coordinationRole: "core_agent" }),
      expect.objectContaining({ agent: "codex", status: "missing", coordinationRole: "coding_specialist" }),
    ]));
    expect(JSON.stringify(body)).not.toMatch(/secret|token|anthropic|\/home\//i);
  });

  it("upgrades connected Claude or Codex without removing Hermes", async () => {
    const service = createAgentCredentialStatusService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const verified = await app.request(post("/credentials/codex/verify"));
    expect(verified.status).toBe(200);
    await expect(verified.json()).resolves.toMatchObject({
      agent: "codex",
      status: "available",
      verifiedAt: "2026-05-23T00:00:00.000Z",
    });

    const body = await (await app.request("/credentials/status")).json();
    expect(body.systemAgent).toBe("hermes");
    expect(body.activeAgents).toEqual(["codex", "hermes"]);
    expect(body.routingExplanation).toContain("Hermes remains");
  });

  it("accepts bodyless verify requests because no payload is required", async () => {
    const service = createAgentCredentialStatusService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const verified = await app.request(new Request("http://localhost/credentials/claude/verify", {
      method: "POST",
    }));

    expect(verified.status).toBe(200);
    await expect(verified.json()).resolves.toMatchObject({
      agent: "claude",
      status: "available",
      verifiedAt: "2026-05-23T00:00:00.000Z",
    });
  });

  it("rejects invalid agent identifiers with a generic error", async () => {
    const service = createAgentCredentialStatusService();
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/credentials/not-a-real-agent/verify"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });

  it("does not verify Hermes because it is already the system agent", async () => {
    const service = createAgentCredentialStatusService();
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/credentials/hermes/verify"));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_request",
      retryable: false,
    });
  });

  it("rejects oversized verify bodies before credential updates", async () => {
    const service = createAgentCredentialStatusService();
    const app = createAgentCredentialRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(new Request("http://localhost/credentials/claude/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(2048) }),
    }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "payload_too_large",
      message: "Request body is too large",
      retryable: false,
    });
    await expect((await app.request("/credentials/status")).json()).resolves.toMatchObject({
      activeAgents: ["hermes"],
    });
  });
});
