import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  ReadinessResponseSchema,
  SelectGoalsRequestSchema,
} from "../../packages/gateway/src/onboarding/activation-contracts.js";
import { stepsForGoals } from "../../packages/gateway/src/onboarding/readiness-service.js";
import { mapActivationError, safeClientMessage } from "../../packages/gateway/src/onboarding/activation-errors.js";
import { ReadinessStatusCache } from "../../packages/gateway/src/onboarding/readiness-cache.js";
import { createAgentActionAuditService } from "../../packages/gateway/src/onboarding/agent-action-audit.js";
import { createTestReadinessService, testPrincipal } from "../helpers/activation-readiness.js";

describe("activation readiness contracts", () => {
  it("requires Hermes to remain the system agent in readiness responses", async () => {
    const { service } = createTestReadinessService();

    const readiness = await service.getReadiness(testPrincipal.userId);

    expect(() => ReadinessResponseSchema.parse(readiness)).not.toThrow();
    expect(readiness.systemAgent).toBe("hermes");
    expect(readiness.activeAgents).toEqual(["hermes"]);
    expect(readiness.agents.find((agent) => agent.agent === "hermes")).toMatchObject({
      status: "available",
      coordinationRole: "system_agent",
    });
  });

  it("keeps Hermes additive when Claude or Codex credentials are connected later", async () => {
    const { service } = createTestReadinessService(undefined, {
      agentCredentials: {
        systemAgent: "hermes",
        activeAgents: ["claude", "codex", "hermes"],
        routingExplanation: "Hermes remains the Matrix system agent while Claude and Codex add specialist paths.",
        agents: [
          {
            agent: "claude",
            status: "available",
            coordinationRole: "core_agent",
            workflows: ["core_agent"],
            degradedWorkflows: [],
            verifiedAt: "2026-05-23T00:00:00.000Z",
            nextAction: null,
          },
          {
            agent: "codex",
            status: "available",
            coordinationRole: "coding_specialist",
            workflows: ["coding"],
            degradedWorkflows: [],
            verifiedAt: "2026-05-23T00:00:00.000Z",
            nextAction: null,
          },
          {
            agent: "hermes",
            status: "available",
            coordinationRole: "system_agent",
            workflows: ["app_building", "assistant", "integrations", "company_brain"],
            degradedWorkflows: [],
            verifiedAt: null,
            nextAction: null,
          },
        ],
      },
    });

    const readiness = await service.getReadiness(testPrincipal.userId);

    expect(readiness.systemAgent).toBe("hermes");
    expect(readiness.activeAgents).toEqual(["claude", "codex", "hermes"]);
    expect(readiness.agents.find((agent) => agent.agent === "hermes")).toMatchObject({
      status: "available",
      coordinationRole: "system_agent",
    });
    expect(readiness.gates.find((gate) => gate.id === "hermes.continuity")).toMatchObject({
      status: "pass",
      message: "Hermes remains available as the Matrix system agent",
    });
  });

  it("derives degraded status until release-critical gates pass", async () => {
    const { service } = createTestReadinessService();

    const readiness = await service.getReadiness(testPrincipal.userId);

    expect(readiness.overallStatus).toBe("degraded");
    expect(readiness.gates.filter((gate) => gate.criticality === "release_critical").length).toBeGreaterThan(0);
  });

  it("validates goal request boundaries", () => {
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: ["coding"] })).not.toThrow();
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: [] })).toThrow();
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: ["unknown-launch-slug"] })).toThrow();
  });

  it("merges shared setup step unlocks across selected goals", () => {
    const hermesStep = stepsForGoals(["app_building", "assistant"]).find((step) => step.id === "hermes.continuity");

    expect(hermesStep).toMatchObject({
      required: true,
      unlocks: ["app_building", "assistant"],
    });
  });

  it("keeps assistant integration gate unknown when no capabilities are connected yet", async () => {
    const integrations = {
      listCapabilities: async () => ({ capabilities: [] }),
      getCapabilityApproval: async () => null,
      setApproval: async () => ({ capabilityId: "calendar.create_event" as const, agent: "hermes" as const, status: "unavailable" as const }),
    };
    const { service } = createTestReadinessService(undefined, { integrationCapabilityService: integrations });

    await service.selectGoals(testPrincipal.userId, ["assistant"]);
    const readiness = await service.getReadiness(testPrincipal.userId);

    expect(readiness.gates.find((gate) => gate.id === "integrations.capabilities")).toMatchObject({
      status: "unknown",
    });
  });

  it("sanitizes unsafe error strings before sending them to clients", () => {
    expect(safeClientMessage("postgres constraint failed at /home/matrix/secret")).toBe("Request failed");
    expect(safeClientMessage("Connect GitHub to continue")).toBe("Connect GitHub to continue");

    const mapped = mapActivationError(new z.ZodError([]));
    expect(mapped).toMatchObject({
      status: 400,
      body: { error: "invalid_request", message: "Request is invalid", retryable: false },
    });
  });

  it("evicts readiness cache entries by LRU and TTL", () => {
    let now = 1000;
    const cache = new ReadinessStatusCache<{ value: string }>({ maxEntries: 2, ttlMs: 50 }, () => now);

    cache.set("a", { value: "A" });
    cache.set("b", { value: "B" });
    expect(cache.get("a")).toEqual({ value: "A" });
    cache.set("c", { value: "C" });

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toEqual({ value: "A" });
    now = 1100;
    expect(cache.get("a")).toBeNull();
  });

  it("records safe agent action summaries without raw provider details", async () => {
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });

    const action = await audit.recordAction(testPrincipal.userId, {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created launch rehearsal event; raw provider token sk_live at /home/matrix/secret failed before retry",
      target: "Primary calendar",
    });

    expect(action).toMatchObject({
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      target: "Primary calendar",
      createdAt: "2026-05-23T00:00:00.000Z",
      completedAt: "2026-05-23T00:00:00.000Z",
    });
    expect(action.summary).toBe("Agent action completed");
    expect(JSON.stringify(action)).not.toMatch(/sk_live|\/home|token/i);
  });
});
