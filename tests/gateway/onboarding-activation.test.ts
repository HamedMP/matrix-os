import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  ReadinessResponseSchema,
  SelectGoalsRequestSchema,
} from "../../packages/gateway/src/onboarding/activation-contracts.js";
import { stepsForGoals } from "../../packages/gateway/src/onboarding/readiness-service.js";
import { mapActivationError, safeClientMessage } from "../../packages/gateway/src/onboarding/activation-errors.js";
import { ReadinessStatusCache } from "../../packages/gateway/src/onboarding/readiness-cache.js";
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

  it("derives degraded status until release-critical gates pass", async () => {
    const { service } = createTestReadinessService();

    const readiness = await service.getReadiness(testPrincipal.userId);

    expect(readiness.overallStatus).toBe("degraded");
    expect(readiness.gates.filter((gate) => gate.criticality === "release_critical").length).toBeGreaterThan(0);
  });

  it("validates goal request boundaries", () => {
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: ["coding"] })).not.toThrow();
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: [] })).toThrow();
    expect(() => SelectGoalsRequestSchema.parse({ goalIds: ["paid-beta-readiness"] })).toThrow();
  });

  it("merges shared setup step unlocks across selected goals", () => {
    const hermesStep = stepsForGoals(["app_building", "assistant"]).find((step) => step.id === "hermes.available");

    expect(hermesStep).toMatchObject({
      required: true,
      unlocks: ["app_building", "assistant"],
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
});
