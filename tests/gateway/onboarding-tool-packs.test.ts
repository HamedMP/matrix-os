import { describe, expect, it } from "vitest";
import {
  SelectToolPacksRequestSchema,
  ToolPacksResponseSchema,
} from "../../packages/gateway/src/onboarding/activation-contracts.js";
import { createToolPackRoutes } from "../../packages/gateway/src/onboarding/tool-pack-routes.js";
import {
  InMemoryToolPackRepository,
  createToolPackService,
  type ToolPackInstaller,
} from "../../packages/gateway/src/onboarding/tool-packs.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("onboarding tool packs", () => {
  it("exposes selectable boot-time tool packs without requiring every tool in the bundle", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });

    const response = await service.listToolPacks(testPrincipal.userId);

    expect(() => ToolPacksResponseSchema.parse(response)).not.toThrow();
    expect(response.packs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "coding-agents",
        status: "available",
        selected: false,
        commands: ["claude", "codex", "opencode", "pi"],
      }),
      expect.objectContaining({
        id: "hermes",
        category: "agent",
        status: "selected",
        selected: true,
      }),
      expect.objectContaining({
        id: "code-server",
        category: "editor",
        status: "available",
      }),
    ]));
    expect(response.selectedPackIds).toEqual(["hermes"]);
  });

  it("validates bounded tool selections and preserves selected pack order", async () => {
    expect(() => SelectToolPacksRequestSchema.parse({
      packIds: ["coding-agents", "code-server", "hermes"],
    })).not.toThrow();
    expect(() => SelectToolPacksRequestSchema.parse({ packIds: [] })).toThrow();
    expect(() => SelectToolPacksRequestSchema.parse({ packIds: ["../../bin/sh"] })).toThrow();

    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const response = await service.selectToolPacks(testPrincipal.userId, [
      "coding-agents",
      "hermes",
      "coding-agents",
    ]);

    expect(response.selectedPackIds).toEqual(["coding-agents", "hermes"]);
    expect(response.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      selected: true,
      status: "selected",
    });
  });

  it("starts selected tool installs in parallel and returns live job state", async () => {
    const started: string[] = [];
    const installer: ToolPackInstaller = {
      install: async (_ownerId, packId) => {
        started.push(packId);
      },
    };
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      installer,
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });

    const response = await service.installToolPacks(testPrincipal.userId, ["coding-agents", "code-server"]);

    expect(response.installJobs).toHaveLength(2);
    expect(response.installJobs.map((job) => job.status)).toEqual(["installing", "installing"]);
    expect(response.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      selected: true,
      status: "installing",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await service.listToolPacks(testPrincipal.userId);

    expect(started).toEqual(expect.arrayContaining(["coding-agents", "code-server"]));
    expect(completed.installJobs.map((job) => job.status)).toEqual(["installed", "installed"]);
    expect(completed.packs.find((pack) => pack.id === "code-server")).toMatchObject({
      installed: true,
      status: "installed",
    });
  });

  it("routes selection and install requests through owner-scoped onboarding APIs", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      installer: { install: async () => {} },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const app = createToolPackRoutes({ service, getPrincipal: () => testPrincipal });

    const selection = await app.request(jsonRequest("/tools/selection", {
      packIds: ["coding-agents", "hermes"],
    }));
    expect(selection.status).toBe(200);
    await expect(selection.json()).resolves.toMatchObject({
      selectedPackIds: ["coding-agents", "hermes"],
    });

    const install = await app.request(jsonRequest("/tools/install", {
      packIds: ["coding-agents"],
    }));
    expect(install.status).toBe(202);
    await expect(install.json()).resolves.toMatchObject({
      selectedPackIds: ["coding-agents", "hermes"],
      installJobs: [expect.objectContaining({ packId: "coding-agents", status: "installing" })],
    });
  });

  it("rejects invalid tool pack route payloads with a generic client-safe error", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const app = createToolPackRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(jsonRequest("/tools/selection", {
      packIds: ["../../secrets"],
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });
});
