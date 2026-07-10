import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  boundedListSchema,
} from "../../packages/contracts/src/index.js";
import {
  createCodingAgentRuntimeSummaryService,
  type CodingAgentTerminalSessionRegistry,
} from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import {
  CodingAgentReviewSnapshotError,
  createCodingAgentReviewSummaryStore,
  type ReviewLoopStore,
} from "../../packages/gateway/src/coding-agents/review-summary.js";
import { createCodingAgentPreviewSummaryStore } from "../../packages/gateway/src/coding-agents/preview-summary.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-07-06T12:00:00.000Z");
const execFileAsync = promisify(execFile);

function reviewRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev_1",
    projectSlug: "matrix-os",
    worktreeId: "wt_abc123def456",
    pr: 758,
    status: "reviewing",
    round: 1,
    maxRounds: 3,
    reviewer: "codex",
    implementer: "claude",
    convergenceGate: "findings_only",
    verificationCommands: [],
    rounds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function successfulFindingsRound(overrides: Record<string, unknown> = {}) {
  return {
    round: 1,
    phase: "review",
    parserStatus: "success",
    findingsPath: ".matrix/review-round-1.md",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    ...overrides,
  };
}

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

function capability(summary: ReturnType<typeof RuntimeSummarySchema.parse>, id: string) {
  const match = summary.capabilities.find((candidate) => candidate.id === id);
  expect(match).toBeDefined();
  return match!;
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

  it("only advertises providers registered for coding-agent thread starts", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      agentCredentials: {
        getStatus: async () => ({
          systemAgent: "hermes",
          activeAgents: ["claude", "codex", "hermes"],
          routingExplanation: "Codex is available for coding-agent starts.",
          agents: [
            {
              agent: "claude",
              status: "available",
              coordinationRole: "coding_specialist",
              workflows: ["coding"],
              degradedWorkflows: [],
              verifiedAt: now.toISOString(),
              nextAction: null,
            },
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
      providerIds: ["codex"],
      now: () => now,
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.providers.map((provider) => provider.id)).toEqual(["codex"]);
  });

  it("hydrates provider summaries through the owner-scoped provider registry", async () => {
    const listProviders = vi.fn(async () => [{
      id: "codex",
      displayName: "Codex",
      kind: "codex" as const,
      availability: "available" as const,
      installStatus: "installed" as const,
      authStatus: "authenticated" as const,
      supportedModes: ["default" as const],
      defaultMode: "default" as const,
      setupActions: [],
      lastCheckedAt: now.toISOString(),
    }]);
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      providerRegistry: { listProviders },
      now: () => now,
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(listProviders).toHaveBeenCalledWith(testPrincipal);
    expect(summary.providers).toEqual([
      expect.objectContaining({ id: "codex", availability: "available" }),
    ]);
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

  it("advertises enabled shell capabilities when runtime dependencies are wired", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(1),
      threads: {
        listThreads: async () => ({ items: [], hasMore: false, limit: 50 }),
      },
      capabilities: {
        workspace: true,
        approvals: true,
        sameThreadTurns: true,
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codingAgentsRuntimeSummary", enabled: true }),
      expect.objectContaining({ id: "codingAgentsDesktopWorkspace", enabled: true }),
      expect.objectContaining({ id: "codingAgentsMobileWorkspace", enabled: true }),
      expect.objectContaining({ id: "codingAgentsThreadCreate", enabled: true }),
      expect.objectContaining({ id: "codingAgentsSameThreadTurns", enabled: true }),
      expect.objectContaining({ id: "codingAgentsApprovals", enabled: true }),
      expect.objectContaining({ id: "codingAgentsNativeMobileTerminal", enabled: true }),
    ]));
  });

  it("does not expose workspace or approval capabilities from thread storage alone", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      threads: {
        listThreads: async () => ({ items: [], hasMore: false, limit: 50 }),
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(capability(summary, "codingAgentsThreadCreate")).toMatchObject({ enabled: true });
    expect(capability(summary, "codingAgentsSameThreadTurns")).toMatchObject({ enabled: false });
    expect(capability(summary, "codingAgentsDesktopWorkspace")).toMatchObject({ enabled: false });
    expect(capability(summary, "codingAgentsMobileWorkspace")).toMatchObject({ enabled: false });
    expect(capability(summary, "codingAgentsApprovals")).toMatchObject({ enabled: false });
  });

  it("withholds file capability from principals outside the file owner allowlist", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      capabilities: { files: true },
      filesOwnerId: "owner_user",
      now: () => now,
    });
    const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };

    const summary = RuntimeSummarySchema.parse(await service.getSummary(otherPrincipal));

    expect(capability(summary, "codingAgentsFiles")).toMatchObject({ enabled: false });
  });

  it("exposes bounded attention threads separately from active threads", async () => {
    const activeThread = {
      id: "thread_running",
      providerId: "codex",
      title: "Continue implementation",
      status: "running",
      attention: "none",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    } as const;
    const failedThread = {
      id: "thread_failed",
      providerId: "codex",
      title: "Repair failed run",
      status: "failed",
      attention: "failed",
      createdAt: now.toISOString(),
      updatedAt: new Date(now.getTime() + 1000).toISOString(),
    } as const;
    const approvalThread = {
      id: "thread_approval",
      providerId: "codex",
      title: "Approve deployment",
      status: "waiting_for_approval",
      attention: "approval_required",
      createdAt: now.toISOString(),
      updatedAt: new Date(now.getTime() + 2000).toISOString(),
    } as const;
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      threads: {
        listThreads: async () => ({ items: [activeThread, approvalThread], hasMore: false, limit: 50 }),
        listAttentionThreads: async () => ({ items: [approvalThread, failedThread], hasMore: false, limit: 50 }),
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.activeThreads.items.map((thread) => thread.id)).toEqual(["thread_running", "thread_approval"]);
    expect(summary.attentionThreads.items.map((thread) => thread.id)).toEqual(["thread_approval", "thread_failed"]);
    expect(JSON.stringify(summary)).not.toMatch(/\/home\/matrix|Postgres|token|secret/i);
  });

  it("exposes bounded safe preview summaries when the preview adapter is wired", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      previews: {
        listPreviewSessions: async () => ({
          items: Array.from({ length: 60 }, (_, index) => ({
            id: `prev_${index}`,
            label: index === 0 ? "Local web app" : `Preview ${index}`,
            status: index === 0 ? "running" : "unknown",
            origin: index === 0 ? "http://localhost:3000" : undefined,
            updatedAt: new Date(now.getTime() - index * 1000).toISOString(),
          })),
          hasMore: true,
          limit: 50,
        }),
      },
      capabilities: {
        preview: true,
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(capability(summary, "codingAgentsPreview")).toMatchObject({ enabled: true });
    expect(summary.previewSessions.items).toHaveLength(50);
    expect(summary.previewSessions.hasMore).toBe(true);
    expect(summary.previewSessions.items[0]).toMatchObject({
      id: "prev_0",
      label: "Local web app",
      status: "running",
      origin: "http://localhost:3000",
    });
    expect(JSON.stringify(summary)).not.toMatch(/\/home\/matrix|Postgres|token|secret/i);
  });

  it("keeps preview summaries generic when the preview adapter fails", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      previews: {
        listPreviewSessions: async () => {
          throw new Error("preview token failed at /home/matrix/home");
        },
      },
      capabilities: {
        preview: true,
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(capability(summary, "codingAgentsPreview")).toMatchObject({ enabled: true });
    expect(summary.previewSessions).toEqual({ items: [], hasMore: false, limit: 50 });
    expect(JSON.stringify(summary)).not.toMatch(/\/home\/matrix|preview token|Postgres|secret/i);
  });

  it("adapts existing workspace preview records into safe coding-agent summaries", async () => {
    const listPreviews = vi.fn(async () => ({
      ok: true as const,
      previews: [
        {
          id: "prev_local",
          projectSlug: "repo",
          label: "Local web app",
          url: "http://localhost:3000/dashboard?token=secret",
          lastStatus: "ok",
          displayPreference: "panel",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          id: "prev_internal",
          projectSlug: "repo",
          label: "Internal service",
          url: "http://internal.service:8080/private",
          lastStatus: "ok",
          displayPreference: "external",
          createdAt: now.toISOString(),
          updatedAt: new Date(now.getTime() - 1000).toISOString(),
        },
      ],
      nextCursor: null,
    }));
    const store = createCodingAgentPreviewSummaryStore({
      homePath: "/home/matrix/home",
      previewManager: { listPreviews },
      projectSlugs: async () => ["repo"],
      ownerId: testPrincipal.userId,
    });

    const summaries = await store.listPreviewSessions(testPrincipal);

    expect(listPreviews).toHaveBeenCalledWith("repo", { limit: 50 });
    expect(summaries).toEqual({
      items: [
        {
          id: "prev_local",
          projectId: "repo",
          label: "Local web app",
          status: "running",
          origin: "http://localhost:3000",
          updatedAt: now.toISOString(),
        },
        {
          id: "prev_internal",
          projectId: "repo",
          label: "Internal service",
          status: "running",
          updatedAt: new Date(now.getTime() - 1000).toISOString(),
        },
      ],
      hasMore: false,
      limit: 50,
    });
    expect(JSON.stringify(summaries)).not.toMatch(/token=secret|internal\.service|\/home\/matrix/i);
  });

  it("withholds owner-local preview summaries from other principals", async () => {
    const listPreviews = vi.fn(async () => ({
      ok: true as const,
      previews: [],
      nextCursor: null,
    }));
    const store = createCodingAgentPreviewSummaryStore({
      homePath: "/home/matrix/home",
      previewManager: { listPreviews },
      projectSlugs: async () => ["repo"],
      ownerId: "owner_user",
    });
    const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "configured-container" };

    await expect(store.listPreviewSessions(otherPrincipal)).resolves.toEqual({
      items: [],
      hasMore: false,
      limit: 50,
    });
    expect(listPreviews).not.toHaveBeenCalled();
  });

  it("allows configured Clerk owner principals to read preview summaries", async () => {
    const listPreviews = vi.fn(async () => ({
      ok: true as const,
      previews: [
        {
          id: "prev_local",
          projectSlug: "repo",
          label: "Local web app",
          url: "http://localhost:3000",
          lastStatus: "ok",
          displayPreference: "panel",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      nextCursor: null,
    }));
    const store = createCodingAgentPreviewSummaryStore({
      homePath: "/home/matrix/home",
      previewManager: { listPreviews },
      projectSlugs: async () => ["repo"],
      ownerId: "owner_user",
      principalOwnerIds: ["clerk_owner_subject"],
    });
    const clerkPrincipal: RequestPrincipal = { userId: "clerk_owner_subject", source: "jwt" };

    await expect(store.listPreviewSessions(clerkPrincipal)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "prev_local", origin: "http://localhost:3000" })],
      hasMore: false,
      limit: 50,
    });
    expect(listPreviews).toHaveBeenCalledWith("repo", { limit: 50 });
  });

  it("scans bounded preview pages so newest preview summaries are not hidden by old rows", async () => {
    const oldPreviews = Array.from({ length: 50 }, (_, index) => ({
      id: `prev_old_${index}`,
      projectSlug: "repo",
      label: `Old preview ${index}`,
      url: "http://localhost:3000",
      lastStatus: "ok" as const,
      displayPreference: "panel" as const,
      createdAt: new Date(now.getTime() - (100 + index) * 1000).toISOString(),
      updatedAt: new Date(now.getTime() - (100 + index) * 1000).toISOString(),
    }));
    const newestPreview = {
      id: "prev_newest",
      projectSlug: "repo",
      label: "Newest preview",
      url: "http://localhost:4000",
      lastStatus: "ok" as const,
      displayPreference: "panel" as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const listPreviews = vi.fn(async (_projectSlug: string, input?: unknown) => {
      const cursor = typeof input === "object" && input && "cursor" in input ? (input as { cursor?: string }).cursor : undefined;
      return cursor === "prev_old_49"
        ? { ok: true as const, previews: [newestPreview], nextCursor: null }
        : { ok: true as const, previews: oldPreviews, nextCursor: "prev_old_49" };
    });
    const store = createCodingAgentPreviewSummaryStore({
      homePath: "/home/matrix/home",
      previewManager: { listPreviews },
      projectSlugs: async () => ["repo"],
      ownerId: testPrincipal.userId,
    });

    const summaries = await store.listPreviewSessions(testPrincipal);

    expect(summaries.items[0]).toMatchObject({
      id: "prev_newest",
      label: "Newest preview",
      origin: "http://localhost:4000",
    });
    expect(summaries.items).toHaveLength(50);
    expect(listPreviews).toHaveBeenCalledWith("repo", { limit: 50 });
    expect(listPreviews).toHaveBeenCalledWith("repo", { limit: 50, cursor: "prev_old_49" });
  });

  it("scopes preview summaries to the requested project before applying bounds", async () => {
    const otherPreviews = Array.from({ length: 50 }, (_, index) => ({
      id: `prev_other_${index}`,
      projectSlug: "other",
      label: `Other preview ${index}`,
      url: "http://localhost:3000",
      lastStatus: "ok" as const,
      displayPreference: "panel" as const,
      createdAt: new Date(now.getTime() + index * 1000).toISOString(),
      updatedAt: new Date(now.getTime() + index * 1000).toISOString(),
    }));
    const repoPreview = {
      id: "prev_repo",
      projectSlug: "repo",
      label: "Repo preview",
      url: "http://localhost:4000",
      lastStatus: "ok" as const,
      displayPreference: "panel" as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const listPreviews = vi.fn(async (projectSlug: string) => ({
      ok: true as const,
      previews: projectSlug === "repo" ? [repoPreview] : otherPreviews,
      nextCursor: null,
    }));
    const store = createCodingAgentPreviewSummaryStore({
      homePath: "/home/matrix/home",
      previewManager: { listPreviews },
      projectSlugs: async () => ["other", "repo"],
      ownerId: testPrincipal.userId,
    });

    const summaries = await store.listPreviewSessions(testPrincipal, { projectId: "repo" });

    expect(summaries.items).toEqual([
      expect.objectContaining({
        id: "prev_repo",
        projectId: "repo",
        label: "Repo preview",
        origin: "http://localhost:4000",
      }),
    ]);
    expect(listPreviews).toHaveBeenCalledTimes(1);
    expect(listPreviews).toHaveBeenCalledWith("repo", { limit: 50 });
  });

  it("keeps approvals disabled for workspace providers without approval decision bridging", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      threads: {
        listThreads: async () => ({ items: [], hasMore: false, limit: 50 }),
      },
      capabilities: {
        workspace: true,
        approvals: false,
      },
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(capability(summary, "codingAgentsDesktopWorkspace")).toMatchObject({ enabled: true });
    expect(capability(summary, "codingAgentsMobileWorkspace")).toMatchObject({ enabled: true });
    expect(capability(summary, "codingAgentsThreadCreate")).toMatchObject({ enabled: true });
    expect(capability(summary, "codingAgentsApprovals")).toMatchObject({ enabled: false });
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

  it("passes a validated project scope into authenticated summary requests", async () => {
    const getSummary = vi.fn(async () => RuntimeSummarySchema.parse({
      runtime: { id: "rt_primary", label: "Primary Matrix computer", status: "available" },
      capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
      providers: [],
      projects: { items: [], hasMore: false, limit: 20 },
      activeThreads: { items: [], hasMore: false, limit: 50 },
      attentionThreads: { items: [], hasMore: false, limit: 50 },
      terminalSessions: { items: [], hasMore: false, limit: 20 },
      previewSessions: { items: [], hasMore: false, limit: 50 },
      recentActivity: { items: [], hasMore: false, limit: 30 },
      limits: {
        maxPromptBytes: 24_000,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 65_536,
        maxListItems: 50,
      },
      serverTime: now.toISOString(),
    }));
    const app = createCodingAgentRoutes({ service: { getSummary }, getPrincipal: () => testPrincipal });

    const res = await app.request("/summary?projectId=repo");

    expect(res.status).toBe(200);
    expect(getSummary).toHaveBeenCalledWith(testPrincipal, { projectId: "repo" });
  });

  it("rejects invalid summary project scopes with a safe validation error", async () => {
    const app = createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      getPrincipal: () => testPrincipal,
    });

    const res = await app.request("/summary?projectId=../private");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "validation_failed",
        safeMessage: "Request could not be processed. Check the inputs and try again.",
        retryable: false,
      },
    });
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

  it("serves authenticated capped review summaries through a safe coding-agent route", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(0),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service,
      reviews: {
        listReviews: async () => ({
          items: Array.from({ length: 50 }, (_, index) => ReviewSummarySchema.parse({
            id: `rev_${index}`,
            projectId: "matrix-os",
            worktreeId: "wt_abc123def456",
            status: index === 0 ? "reviewing" : "queued",
            pullRequestNumber: 700 + index,
            round: index,
            maxRounds: 3,
            reviewer: "codex",
            implementer: "claude",
            findings: {
              total: index,
              high: 0,
              medium: index,
              low: 0,
            },
            updatedAt: new Date(now.getTime() - index * 1000).toISOString(),
          })),
          hasMore: true,
          limit: 50,
        }),
      },
      getPrincipal: () => testPrincipal,
    }));

    const res = await app.request("/api/coding-agents/reviews");

    expect(res.status).toBe(200);
    const body = boundedListSchema(ReviewSummarySchema, 50).parse(await res.json());
    expect(body.items).toHaveLength(50);
    expect(body.hasMore).toBe(true);
    expect(body.items[0]).toMatchObject({
      id: "rev_0",
      status: "reviewing",
      findings: { total: 0, high: 0, medium: 0, low: 0 },
    });
    expect(JSON.stringify(body)).not.toMatch(/\/home\/matrix|Postgres|token|secret/i);
  });

  it("serves an authenticated safe review snapshot with partial file metadata", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      terminalRegistry: registryWith(0),
      now: () => now,
      runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service,
      reviews: {
        listReviews: async () => ({ items: [], hasMore: false, limit: 50 }),
        getReviewSnapshot: async () => ReviewSnapshotSchema.parse({
          review: {
            id: "rev_1",
            projectId: "matrix-os",
            worktreeId: "wt_abc123def456",
            status: "reviewing",
            pullRequestNumber: 758,
            round: 1,
            maxRounds: 3,
            reviewer: "codex",
            implementer: "claude",
            findings: { total: 1, high: 1, medium: 0, low: 0 },
            updatedAt: now.toISOString(),
          },
          files: {
            items: [
              {
                path: "packages/gateway/src/coding-agents/routes.ts",
                status: "modified",
                additions: 0,
                deletions: 0,
                partial: true,
                hunks: [
                  {
                    id: "hunk_rev_1_1",
                    oldStart: 42,
                    oldLines: 1,
                    newStart: 42,
                    newLines: 1,
                    heading: "Finding HIGH-1",
                    partial: true,
                  },
                ],
                findings: [
                  {
                    id: "HIGH-1",
                    severity: "high",
                    line: 42,
                    summary: "Validate review identifiers before lookup.",
                  },
                ],
              },
            ],
            hasMore: false,
            limit: 100,
          },
          partial: true,
          safeNotice: "Diff content is not available yet. Showing bounded review findings.",
          updatedAt: now.toISOString(),
        }),
      },
      getPrincipal: () => testPrincipal,
    }));

    const res = await app.request("/api/coding-agents/reviews/rev_1");

    expect(res.status).toBe(200);
    const body = ReviewSnapshotSchema.parse(await res.json());
    expect(body.review.id).toBe("rev_1");
    expect(body.files.items[0]).toMatchObject({
      path: "packages/gateway/src/coding-agents/routes.ts",
      partial: true,
      hunks: [expect.objectContaining({ id: "hunk_rev_1_1", partial: true })],
      findings: [expect.objectContaining({ severity: "high", line: 42 })],
    });
    expect(JSON.stringify(body)).not.toMatch(/\/home\/matrix|Postgres|token|secret/i);
  });

  it("accepts contract-valid encoded review references for snapshots", async () => {
    const requestedReviewIds: string[] = [];
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      reviews: {
        listReviews: async () => ({ items: [], hasMore: false, limit: 50 }),
        getReviewSnapshot: async (_principal, reviewId) => {
          requestedReviewIds.push(reviewId);
          return ReviewSnapshotSchema.parse({
            review: {
              id: reviewId,
              projectId: "matrix-os",
              worktreeId: "wt_abc123def456",
              status: "reviewing",
              pullRequestNumber: 758,
              round: 1,
              maxRounds: 3,
              reviewer: "codex",
              implementer: "claude",
              updatedAt: now.toISOString(),
            },
            files: { items: [], hasMore: false, limit: 100 },
            partial: false,
            updatedAt: now.toISOString(),
          });
        },
      },
      getPrincipal: () => testPrincipal,
    }));

    const res = await app.request("/api/coding-agents/reviews/rev_mobile%3Around.2");

    expect(res.status).toBe(200);
    expect(requestedReviewIds).toEqual(["rev_mobile:round.2"]);
    const body = ReviewSnapshotSchema.parse(await res.json());
    expect(body.review.id).toBe("rev_mobile:round.2");
  });

  it("maps missing review snapshots to a stable safe not-found response", async () => {
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: async () => RuntimeSummarySchema.parse({
        runtime: {
          status: "online",
          statusText: "Ready",
          activeThreads: 0,
          attentionRequired: 0,
          terminals: { items: [], hasMore: false, limit: 20 },
          updatedAt: now.toISOString(),
        },
        capabilities: [],
        providers: { items: [], hasMore: false, limit: 20 },
        threads: { items: [], hasMore: false, limit: 50 },
        reviews: { items: [], hasMore: false, limit: 50 },
        updatedAt: now.toISOString(),
      }) },
      reviews: {
        listReviews: async () => ({ items: [], hasMore: false, limit: 50 }),
        getReviewSnapshot: async () => {
          throw new CodingAgentReviewSnapshotError("review_not_found");
        },
      },
      getPrincipal: () => testPrincipal,
    }));

    const res = await app.request("/api/coding-agents/reviews/rev_missing");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "review_not_found",
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/\/home\/matrix|Postgres|token|secret/i);
  });

  it("withholds owner-local review summaries from other principals", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({ ok: true, reviews: [reviewRecord()], nextCursor: null }),
    } as ReviewLoopStore, { ownerId: "owner_user" });
    const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "configured-container" };

    await expect(store.listReviews(otherPrincipal)).resolves.toEqual({
      items: [],
      hasMore: false,
      limit: 50,
    });
  });

  it("derives partial review snapshot files from safe structured findings only", async () => {
    const reader = vi.fn(async () => ({
      ok: true as const,
      parserStatus: "success" as const,
      findingsCount: 2,
      severityCounts: { high: 1, medium: 1, low: 0 },
      findings: [
        {
          id: "HIGH-1",
          severity: "high" as const,
          file: "packages/gateway/src/coding-agents/routes.ts",
          line: 42,
          summary: "Validate review identifiers before lookup.",
        },
        {
          id: "MED-1",
          severity: "medium" as const,
          file: "/home/matrix/private/secret.ts",
          line: 7,
          summary: "Unsafe path must be dropped.",
        },
      ],
    }));
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({
          ownerId: testPrincipal.userId,
          rounds: [successfulFindingsRound()],
        }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      findingsReader: reader,
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(snapshot.partial).toBe(true);
    expect(snapshot.files).toMatchObject({
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          partial: true,
          hunks: [expect.objectContaining({ oldStart: 42, newStart: 42, partial: true })],
          findings: [expect.objectContaining({ id: "HIGH-1", severity: "high", line: 42 })],
        },
      ],
      hasMore: false,
      limit: 100,
    });
    expect(reader).toHaveBeenCalledWith("/home/matrix/home/projects/matrix-os/worktrees/wt_abc123def456/.matrix/review-round-1.md");
    expect(JSON.stringify(snapshot)).not.toMatch(/\/home\/matrix|secret|Postgres|token/i);
  });

  it("adds bounded diff hunk metadata for safe owner review worktrees", async () => {
    const diffReader = vi.fn(async () => ({
      ok: true as const,
      files: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified" as const,
          additions: 2,
          deletions: 1,
          partial: false,
          hunks: [
            {
              id: "hunk_packages_gateway_src_coding_agents_routes_ts_0",
              oldStart: 10,
              oldLines: 2,
              newStart: 10,
              newLines: 3,
              heading: "@@ -10,2 +10,3 @@",
              partial: false,
            },
          ],
        },
      ],
      hasMore: false,
      partial: false,
    }));
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      diffReader,
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 0,
        severityCounts: { high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(diffReader).toHaveBeenCalledWith("/home/matrix/home/projects/matrix-os/worktrees/wt_abc123def456");
    expect(snapshot.partial).toBe(false);
    expect(snapshot.files).toMatchObject({
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          partial: false,
          hunks: [expect.objectContaining({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, partial: false })],
        },
      ],
      hasMore: false,
      limit: 100,
    });
    expect(JSON.stringify(snapshot)).not.toContain("/home/matrix/home");
  });

  it("summarizes a small git diff from a safe owner review worktree", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-diff-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding-agents");
      const spacedSourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding agents");
      const tabbedSourceDir = join(worktreeRoot, "packages", "gateway", "src", "tabbed\tagents");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(spacedSourceDir, { recursive: true });
      await mkdir(tabbedSourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 1;\n");
      await writeFile(join(spacedSourceDir, "quoted.ts"), "export const quoted = 1;\n");
      await writeFile(join(tabbedSourceDir, "quoted.ts"), "export const tabbed = 1;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 2;\nexport const next = 3;\n");
      await writeFile(join(spacedSourceDir, "quoted.ts"), "export const quoted = 2;\n");
      await writeFile(join(tabbedSourceDir, "quoted.ts"), "export const tabbed = 2;\n");
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

      expect(snapshot.partial).toBe(true);
      expect(snapshot.safeNotice).toBe("Some diff content is unavailable. Showing bounded review metadata.");
      expect(snapshot.files.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          partial: true,
          hunks: [expect.objectContaining({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 })],
        }),
        expect.objectContaining({
          path: "packages/gateway/src/coding agents/quoted.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          partial: true,
          hunks: [expect.objectContaining({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })],
        }),
        expect.objectContaining({
          path: "packages/gateway/src/tabbed\tagents/quoted.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          partial: true,
          hunks: [expect.objectContaining({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })],
        }),
      ]));
      expect(snapshot.files.items).toHaveLength(3);
      expect(JSON.stringify(snapshot)).not.toContain(homePath);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("includes bounded hunk lines for a small git diff from a safe owner review worktree", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-diff-lines-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding-agents");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.email", "matrix@example.invalid"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.name", "Matrix Review"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), [
        "export function route() {",
        "  return 1;",
        "}",
        "",
      ].join("\n"));
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: worktreeRoot });
      await execFileAsync("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), [
        "export function route() {",
        "  const next = 2;",
        "  return next;",
        "}",
        "",
      ].join("\n"));
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");
      const hunk = snapshot.files.items[0]?.hunks[0];

      expect(snapshot.partial).toBe(false);
      expect(hunk?.partial).toBe(false);
      expect(hunk?.lines).toEqual([
        { kind: "context", oldLine: 1, newLine: 1, content: "export function route() {" },
        { kind: "remove", oldLine: 2, content: "  return 1;" },
        { kind: "add", newLine: 2, content: "  const next = 2;" },
        { kind: "add", newLine: 3, content: "  return next;" },
        { kind: "context", oldLine: 3, newLine: 4, content: "}" },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain(homePath);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("caps large diff hunk line bodies and marks the snapshot partial", async () => {
    const diffReader = vi.fn(async () => ({
      ok: true as const,
      files: [{
        path: "packages/gateway/src/coding-agents/routes.ts",
        status: "modified" as const,
        additions: 160,
        deletions: 0,
        partial: false,
        hunks: [{
          id: "hunk_large",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 160,
          partial: false,
          lines: Array.from({ length: 160 }, (_, index) => ({
            kind: "add" as const,
            newLine: index + 1,
            content: `const value${index} = ${index};`,
          })),
        }],
      }],
      hasMore: false,
      partial: false,
    }));
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      diffReader,
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 0,
        severityCounts: { high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");
    const hunk = snapshot.files.items[0]?.hunks[0];

    expect(hunk?.lines).toHaveLength(120);
    expect(hunk?.partial).toBe(true);
    expect(snapshot.files.items[0]?.partial).toBe(true);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.safeNotice).toBe("Some diff content is unavailable. Showing bounded review metadata.");
  });

  it("keeps unquoted binary diff headers aligned when paths contain the header separator text", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-binary-header-diff-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "foo", " b");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "core.quotePath", "false"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.email", "matrix@example.invalid"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.name", "Matrix Review"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "bar.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: worktreeRoot });
      await execFileAsync("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "bar.bin"), Buffer.from([0, 1, 2, 9, 4, 5]));
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

      expect(snapshot.partial).toBe(true);
      expect(snapshot.safeNotice).toBe("Some diff content is unavailable. Showing bounded review metadata.");
      expect(snapshot.files.items).toEqual([
        expect.objectContaining({
          path: "packages/foo/ b/bar.bin",
          status: "binary",
          partial: true,
        }),
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps snapshots partial when an empty diff falls back to findings metadata", async () => {
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      diffReader: async () => ({
        ok: true,
        files: [],
        hasMore: false,
        partial: false,
      }),
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 1,
        severityCounts: { high: 1, medium: 0, low: 0 },
        findings: [{
          id: "HIGH-1",
          severity: "high",
          file: "packages/gateway/src/coding-agents/routes.ts",
          line: 42,
          summary: "Finding-only metadata remains partial.",
        }],
      }),
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(snapshot.partial).toBe(true);
    expect(snapshot.safeNotice).toBe("Some diff content is unavailable. Showing bounded review metadata.");
    expect(snapshot.files.items[0]).toMatchObject({
      path: "packages/gateway/src/coding-agents/routes.ts",
      partial: true,
    });
  });

  it("summarizes committed review branch changes against the tracked base", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-branch-diff-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding-agents");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.email", "matrix@example.invalid"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.name", "Matrix Review"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 1;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: worktreeRoot });
      await execFileAsync("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 2;\nexport const next = 3;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "review change"], { cwd: worktreeRoot });
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

      expect(snapshot.partial).toBe(false);
      expect(snapshot.files.items).toEqual([
        expect.objectContaining({
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          partial: false,
          hunks: [expect.objectContaining({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 })],
        }),
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps committed review snapshots partial when no trusted base ref exists", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-no-base-diff-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding-agents");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.email", "matrix@example.invalid"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.name", "Matrix Review"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 1;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 2;\nexport const next = 3;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "review change"], { cwd: worktreeRoot });
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

      expect(snapshot.partial).toBe(true);
      expect(snapshot.files).toMatchObject({ items: [], hasMore: true, limit: 100 });
      expect(snapshot.safeNotice).toBe("Diff content is not available yet. Showing bounded review state.");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps no-base snapshots partial even when local edits produce diff metadata", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-review-no-base-local-diff-"));
    try {
      const worktreeRoot = join(homePath, "projects", "matrix-os", "worktrees", "wt_abc123def456");
      const sourceDir = join(worktreeRoot, "packages", "gateway", "src", "coding-agents");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(join(worktreeRoot, ".matrix"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.email", "matrix@example.invalid"], { cwd: worktreeRoot });
      await execFileAsync("git", ["config", "user.name", "Matrix Review"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 1;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 2;\nexport const next = 3;\n");
      await execFileAsync("git", ["add", "."], { cwd: worktreeRoot });
      await execFileAsync("git", ["commit", "-m", "review change"], { cwd: worktreeRoot });
      await writeFile(join(sourceDir, "routes.ts"), "export const value = 4;\nexport const next = 3;\n");
      await writeFile(join(worktreeRoot, ".matrix", "review-round-1.md"), "## Findings\n\nNo findings.\n");
      const store = createCodingAgentReviewSummaryStore({
        getReview: async () => ({
          ok: true,
          review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
        }),
        listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
      } as ReviewLoopStore, {
        ownerId: testPrincipal.userId,
        homePath,
      });

      const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

      expect(snapshot.partial).toBe(true);
      expect(snapshot.safeNotice).toBe("Some diff content is unavailable. Showing bounded review metadata.");
      expect(snapshot.files.items).toEqual([
        expect.objectContaining({
          path: "packages/gateway/src/coding-agents/routes.ts",
          partial: true,
        }),
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("returns safe not-found for owner-mismatched review snapshots", async () => {
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({
          ownerId: "other_owner",
          rounds: [successfulFindingsRound()],
        }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 0,
        severityCounts: { high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    });

    await expect(store.getReviewSnapshot!(testPrincipal, "rev_1")).rejects.toMatchObject({
      code: "review_not_found",
    });
  });

  it("returns safe not-found for unowned review snapshots", async () => {
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 0,
        severityCounts: { high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    });

    await expect(store.getReviewSnapshot!(testPrincipal, "rev_1")).rejects.toMatchObject({
      code: "review_not_found",
    });
  });

  it("does not read unsafe persisted findings paths", async () => {
    const reader = vi.fn(async () => ({
      ok: true as const,
      parserStatus: "success" as const,
      findingsCount: 1,
      severityCounts: { high: 1, medium: 0, low: 0 },
      findings: [{
        id: "HIGH-1",
        severity: "high" as const,
        file: "packages/gateway/src/coding-agents/routes.ts",
        line: 42,
        summary: "Should not be read.",
      }],
    }));
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({
          ownerId: testPrincipal.userId,
          rounds: [successfulFindingsRound({ findingsPath: "/home/matrix/private/review-findings.md" })],
        }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, { ownerId: testPrincipal.userId, homePath: "/home/matrix/home", findingsReader: reader });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(snapshot.files).toMatchObject({ items: [], hasMore: false, limit: 100 });
    expect(reader).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toMatch(/\/home\/matrix|secret|token/i);
  });

  it("reports snapshot overflow when distinct findings files exceed the cap", async () => {
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 101,
        severityCounts: { high: 101, medium: 0, low: 0 },
        findings: Array.from({ length: 101 }, (_, index) => ({
          id: `HIGH-${index}`,
          severity: "high" as const,
          file: `packages/example/file-${index}.ts`,
          line: 1,
          summary: "Bounded finding.",
        })),
      }),
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(snapshot.files.items).toHaveLength(100);
    expect(snapshot.files.hasMore).toBe(true);
  });

  it("reports snapshot overflow when one file exceeds the per-file finding cap", async () => {
    const store = createCodingAgentReviewSummaryStore({
      getReview: async () => ({
        ok: true,
        review: reviewRecord({ ownerId: testPrincipal.userId, rounds: [successfulFindingsRound()] }),
      }),
      listReviews: async () => ({ ok: true, reviews: [], nextCursor: null }),
    } as ReviewLoopStore, {
      ownerId: testPrincipal.userId,
      homePath: "/home/matrix/home",
      findingsReader: async () => ({
        ok: true,
        parserStatus: "success",
        findingsCount: 101,
        severityCounts: { high: 101, medium: 0, low: 0 },
        findings: Array.from({ length: 101 }, (_, index) => ({
          id: `HIGH-${index}`,
          severity: "high" as const,
          file: "packages/example/shared.ts",
          line: index + 1,
          summary: "Bounded finding.",
        })),
      }),
    });

    const snapshot = await store.getReviewSnapshot!(testPrincipal, "rev_1");

    expect(snapshot.files.items).toHaveLength(1);
    expect(snapshot.files.items[0]?.findings).toHaveLength(100);
    expect(snapshot.files.hasMore).toBe(true);
  });

  it("allows validated jwt review readers even when the configured owner id uses another owner identifier", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({
        ok: true,
        reviews: [reviewRecord({ ownerId: "owner_user" })],
        nextCursor: null,
      }),
    } as ReviewLoopStore, { ownerId: "owner_user", principalOwnerIds: ["clerk_owner_subject"] });
    const jwtPrincipal: RequestPrincipal = { userId: "clerk_owner_subject", source: "jwt" };

    await expect(store.listReviews(jwtPrincipal)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "rev_1" })],
      hasMore: false,
      limit: 50,
    });
  });

  it("withholds owner-local review summaries from jwt principals outside the owner id allowlist", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({ ok: true, reviews: [reviewRecord()], nextCursor: null }),
    } as ReviewLoopStore, { ownerId: "owner_user", principalOwnerIds: ["clerk_owner_subject"] });
    const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };

    await expect(store.listReviews(otherPrincipal)).resolves.toEqual({
      items: [],
      hasMore: false,
      limit: 50,
    });
  });

  it("filters legacy ownerless and other-owner review summaries before returning them", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({
        ok: true,
        reviews: [
          reviewRecord({ id: "rev_owner", ownerId: "owner_user" }),
          reviewRecord({ id: "rev_ownerless" }),
          reviewRecord({ id: "rev_other", ownerId: "other_user" }),
        ],
        nextCursor: null,
      }),
    } as ReviewLoopStore, { ownerId: "owner_user", principalOwnerIds: ["clerk_owner_subject"] });
    const jwtPrincipal: RequestPrincipal = { userId: "clerk_owner_subject", source: "jwt" };

    const result = await store.listReviews(jwtPrincipal);

    expect(result.items.map((item) => item.id)).toEqual(["rev_owner"]);
    expect(result.hasMore).toBe(false);
  });

  it("does not report more review pages only because malformed records were dropped", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({
        ok: true,
        reviews: [
          reviewRecord({ id: "../bad", projectSlug: "/home/matrix/private" }),
          reviewRecord({ id: "rev_good" }),
        ],
        nextCursor: null,
      }),
    } as ReviewLoopStore);

    await expect(store.listReviews(testPrincipal)).resolves.toEqual({
      items: [expect.objectContaining({ id: "rev_good" })],
      hasMore: false,
      limit: 50,
    });
  });

  it("preserves review hasMore only when valid review summaries exceed the page cap", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({
        ok: true,
        reviews: Array.from({ length: 51 }, (_, index) => reviewRecord({ id: `rev_${index}` })),
        nextCursor: null,
      }),
    } as ReviewLoopStore);

    const result = await store.listReviews(testPrincipal);

    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("rev_49");
  });

  it("skips malformed overflow records while preserving a usable review cursor", async () => {
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async () => ({
        ok: true,
        reviews: [
          ...Array.from({ length: 50 }, (_, index) => reviewRecord({ id: `rev_${index}` })),
          reviewRecord({ id: "../bad", projectSlug: "/home/matrix/private" }),
          reviewRecord({ id: "rev_older_valid" }),
        ],
        nextCursor: null,
      }),
    } as ReviewLoopStore);

    const result = await store.listReviews(testPrincipal);

    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("rev_49");
  });

  it("keeps a review cursor when malformed raw pages consume the scan window", async () => {
    let page = 0;
    const store = createCodingAgentReviewSummaryStore({
      listReviews: async ({ cursor }) => {
        page += 1;
        return {
          ok: true,
          reviews: cursor
            ? Array.from({ length: 100 }, (_, index) => reviewRecord({ id: `../bad_${page}_${index}` }))
            : Array.from({ length: 50 }, (_, index) => reviewRecord({ id: `rev_${index}` })),
          nextCursor: cursor ? `rev_after_malformed_page_${page}` : "rev_49",
        };
      },
    } as ReviewLoopStore);

    const result = await store.listReviews(testPrincipal);

    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("rev_49");
  });
});
