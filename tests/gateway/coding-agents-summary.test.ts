import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
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
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-07-06T12:00:00.000Z");

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
    expect(capability(summary, "codingAgentsDesktopWorkspace")).toMatchObject({ enabled: false });
    expect(capability(summary, "codingAgentsMobileWorkspace")).toMatchObject({ enabled: false });
    expect(capability(summary, "codingAgentsApprovals")).toMatchObject({ enabled: false });
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
      listReviews: async () => ({ ok: true, reviews: [reviewRecord()], nextCursor: null }),
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
