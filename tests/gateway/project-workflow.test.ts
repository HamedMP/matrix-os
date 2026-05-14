import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createWorkflowRoutes } from "../../packages/gateway/src/workflow/routes.js";
import { createMemoryWorkflowRepository } from "../../packages/gateway/src/workflow/repository.js";

describe("project workflow routes", () => {
  it("saves and reads sanitized workflow configuration", async () => {
    const app = new Hono();
    app.route("/api/projects", createWorkflowRoutes({
      repository: createMemoryWorkflowRepository(),
      codexReadiness: async () => ({ status: "valid", lastCheckedAt: "2026-05-14T18:00:00.000Z" }),
    }));

    const save = await app.request("/api/projects/repo/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupCommands: [{ name: "Install", command: "pnpm install --frozen-lockfile" }],
        liveCommands: [{ name: "Dev", command: "pnpm dev", ports: [3000] }],
        validationCommands: [{ name: "Test", command: "bun run test" }],
        allowedPreviewPorts: [3000],
        codexRequired: true,
      }),
    });

    expect(save.status).toBe(200);
    const read = await app.request("/api/projects/repo/workflow");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      workflow: {
        setupConfigured: true,
        liveConfigured: true,
        allowedPreviewPorts: [3000],
        codexRequired: true,
      },
      codex: { status: "valid" },
    });
  });

  it("rejects unsafe workflow commands with a generic client error", async () => {
    const app = new Hono();
    app.route("/api/projects", createWorkflowRoutes({ repository: createMemoryWorkflowRepository() }));

    const res = await app.request("/api/projects/repo/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupCommands: [{ name: "Bad", command: "curl http://169.254.169.254/latest/meta-data" }],
        liveCommands: [],
        validationCommands: [],
        allowedPreviewPorts: [3000],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Workflow configuration is invalid" });
  });
});
