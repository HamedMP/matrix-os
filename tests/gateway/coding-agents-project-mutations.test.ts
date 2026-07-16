import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index.js";
import { createCodingAgentProjectMutationService } from "../../packages/gateway/src/coding-agents/project-mutations.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runtimeSummary() {
  return RuntimeSummarySchema.parse({
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 },
    serverTime: "2026-07-12T00:00:00.000Z",
  });
}

async function harness(principal: "owner" | "missing" = "owner") {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-agent-project-create-"));
  cleanup.push(homePath);
  const projects = createProjectManager({ homePath });
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: async () => runtimeSummary() },
    projectMutations: createCodingAgentProjectMutationService({ projects }),
    getPrincipal: () => {
      if (principal === "missing") throw new MissingRequestPrincipalError();
      return testPrincipal;
    },
  }));
  return { app, projects };
}

function createRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("coding agent project mutations", () => {
  it("creates a safe project projection and accepts an idempotent retry", async () => {
    const { app } = await harness();
    const body = {
      mode: "scratch",
      name: "Mobile Workspace",
      slug: "mobile-workspace",
      clientRequestId: "req_mobile_workspace_1",
    };

    const first = await app.request("/api/coding-agents/projects", createRequest(body));
    const repeated = await app.request("/api/coding-agents/projects", createRequest(body));
    const firstBody = await first.json();
    const repeatedBody = await repeated.json();

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(firstBody).toMatchObject({
      existing: false,
      project: { id: "mobile-workspace", label: "Mobile Workspace", status: "available" },
    });
    expect(repeatedBody).toMatchObject({ existing: true, project: firstBody.project });
    expect(JSON.stringify(firstBody)).not.toMatch(/localPath|ownerScope|createRequestId|\/tmp|token/i);
  });

  it("requires authentication and maps invalid or conflicting requests safely", async () => {
    const owner = await harness();
    const missing = await harness("missing");
    const valid = {
      mode: "scratch",
      name: "Mobile Workspace",
      slug: "mobile-workspace",
      clientRequestId: "req_mobile_workspace_1",
    };
    await owner.app.request("/api/coding-agents/projects", createRequest(valid));

    const unauthenticated = await missing.app.request("/api/coding-agents/projects", createRequest(valid));
    const invalid = await owner.app.request("/api/coding-agents/projects", createRequest({ mode: "scratch" }));
    const unsupportedRepository = await owner.app.request("/api/coding-agents/projects", createRequest({
      mode: "github",
      repositoryUrl: "https://example.com/not-supported/repo",
      clientRequestId: "req_unsupported_repository_1",
    }));
    const conflict = await owner.app.request("/api/coding-agents/projects", createRequest({
      ...valid,
      clientRequestId: "req_mobile_workspace_2",
    }));

    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(unsupportedRepository.status).toBe(400);
    expect(conflict.status).toBe(409);
    for (const response of [unauthenticated, invalid, conflict]) {
      expect(JSON.stringify(await response.json())).not.toMatch(/localPath|ownerScope|\/tmp|database|token/i);
    }
  });

  it("rejects oversized mutation bodies before project creation", async () => {
    const { app, projects } = await harness();
    const response = await app.request("/api/coding-agents/projects", createRequest({
      mode: "scratch",
      name: "x".repeat(5_000),
      clientRequestId: "req_oversized_project_1",
    }));

    expect(response.status).toBe(413);
    await expect(projects.getProject("x")).resolves.toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(await response.json())).not.toMatch(/x{100}|\/tmp|token/i);
  });
});
