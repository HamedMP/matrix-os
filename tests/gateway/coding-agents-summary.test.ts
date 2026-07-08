import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index.js";
import {
  createCodingAgentRuntimeSummaryService,
  type CodingAgentTerminalSessionRegistry,
} from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-07-06T12:00:00.000Z");

function registryWith(count: number): CodingAgentTerminalSessionRegistry {
  return {
    list: () => Array.from({ length: count }, (_, index) => ({
      name: `main-${index}`,
      status: index % 3 === 0 ? "exited" as const : "active" as const,
      createdAt: new Date(now.getTime() - index * 1000).toISOString(),
      updatedAt: new Date(now.getTime() - index * 1000).toISOString(),
      attachedClients: index % 2,
    })),
  };
}

describe("coding agent runtime summary", () => {
  it("returns a capped safe runtime summary from provider and terminal state", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(30),
      agentCredentials: {
        getStatus: async () => ({
          systemAgent: "hermes",
          activeAgents: ["codex", "hermes"],
          routingExplanation: "Hermes remains available.",
          agents: [
            {
              agent: "codex",
              status: "available",
              coordinationRole: "coding_specialist",
              workflows: ["coding"],
              degradedWorkflows: [],
              verifiedAt: now.toISOString(),
              nextAction: null,
            },
          ],
        }),
        verifyAgent: vi.fn(),
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        availability: "available",
        authStatus: "authenticated",
        installStatus: "installed",
      }),
    ]);
    expect(summary.terminalSessions.items).toHaveLength(20);
    expect(summary.terminalSessions.hasMore).toBe(true);
    expect(summary.terminalSessions.items[0]).toMatchObject({
      id: "main-0",
      name: "main-0",
      attachable: false,
      status: "exited",
    });
    expect(JSON.stringify(summary)).not.toMatch(/\/home\/matrix|\/bin\/bash|token|secret|Postgres/i);
  });

  it("withholds owner-local terminal sessions from other principals", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(1),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
      terminalOwnerId: "owner_user",
    });
    const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };

    const summary = RuntimeSummarySchema.parse(await service.getSummary(otherPrincipal));

    expect(summary.terminalSessions.items).toEqual([]);
    expect(summary.terminalSessions.hasMore).toBe(false);
  });

  it("withholds terminal sessions for jwt principals when no owner id is configured", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(1),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });
    const jwtPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };

    const summary = RuntimeSummarySchema.parse(await service.getSummary(jwtPrincipal));

    expect(summary.terminalSessions.items).toEqual([]);
    expect(summary.terminalSessions.hasMore).toBe(false);
  });

  it("replaces unsafe terminal cwd labels instead of failing the whole summary", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: {
        list: () => [{
          name: "id_rsa",
          status: "active",
          visualStatus: "running",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          attachedClients: 1,
        }],
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.terminalSessions.items[0]).toMatchObject({
      id: "terminal_private_0",
      name: "Private session",
      status: "running",
      attachable: false,
    });
    expect(JSON.stringify(summary)).not.toMatch(/\.ssh|id_rsa|\/home\/matrix/i);
  });

  it("keeps display-safe terminal names with schema-unsafe ids from failing the summary", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: {
        list: () => [{
          name: "my terminal",
          status: "active",
          visualStatus: "running",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          attachedClients: 1,
        }],
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.terminalSessions.items[0]).toMatchObject({
      id: "terminal_private_0",
      name: "my terminal",
      status: "running",
      attachable: false,
    });
  });

  it("keeps the summary safe when optional dependencies fail", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: {
        list: () => {
          throw new Error("Postgres constraint failed at /home/matrix/home");
        },
      },
      agentCredentials: {
        getStatus: async () => {
          throw new Error("provider token expired");
        },
        verifyAgent: vi.fn(),
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.providers).toEqual([]);
    expect(summary.terminalSessions.items).toEqual([]);
    expect(summary.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codingAgentsRuntimeSummary", enabled: true }),
      expect.objectContaining({ id: "codingAgentsThreadCreate", enabled: false }),
    ]));
    expect(JSON.stringify(summary)).not.toMatch(/Postgres|\/home\/matrix|provider token/i);
  });

  it("serves authenticated summaries through a safe route", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(1),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({ service, getPrincipal: () => testPrincipal }));

    const res = await app.request("/api/coding-agents/summary");

    expect(res.status).toBe(200);
    const body = RuntimeSummarySchema.parse(await res.json());
    expect(body.runtime.id).toBe("rt_primary");
  });

  it("rejects unauthenticated summary requests", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(0),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });
    const app = createCodingAgentRoutes({
      service,
      getPrincipal: () => {
        throw new MissingRequestPrincipalError();
      },
    });

    const res = await app.request("/summary");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("maps unexpected route failures to generic safe errors", async () => {
    const app = createCodingAgentRoutes({
      service: {
        getSummary: async () => {
          throw new Error("Postgres constraint failed at /home/matrix/home");
        },
      },
      getPrincipal: () => testPrincipal,
    });

    const res = await app.request("/summary");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "summary_unavailable",
        safeMessage: "Runtime summary is temporarily unavailable. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });
});
