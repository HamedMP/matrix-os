import { describe, expect, it, vi } from "vitest";
import {
  buildAuthHeaders,
  createSmokeConfig,
  MAX_JSON_BYTES,
  normalizeRuntimeUrl,
  redactForLog,
  runRuntimeSmoke,
  SmokeFailure,
} from "../../scripts/coding-agents/real-runtime-smoke.mjs";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const runtimeSummary = {
  runtime: {
    id: "rt_live_smoke",
    label: "Live Runtime",
    status: "available",
  },
  capabilities: [
    { id: "codingAgentsRuntimeSummary", enabled: true },
    { id: "codingAgentsMobileWorkspace", enabled: true },
  ],
  providers: [
    {
      id: "workspace",
      kind: "custom",
      displayName: "Workspace",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default"],
      defaultMode: "default",
      setupActions: [],
    },
  ],
  projects: { items: [], hasMore: false, limit: 50 },
  activeThreads: {
    items: [
      {
        id: "thread_live_smoke",
        providerId: "workspace",
        title: "Smoke",
        status: "running",
        attention: "none",
        createdAt: "2026-07-09T10:00:00.000Z",
        updatedAt: "2026-07-09T10:01:00.000Z",
        terminalSessionId: "matrix-abc1234",
      },
    ],
    hasMore: false,
    limit: 50,
  },
  attentionThreads: { items: [], hasMore: false, limit: 50 },
  terminalSessions: {
    items: [
      {
        id: "matrix-abc1234",
        name: "matrix",
        status: "running",
        attachable: true,
        createdAt: "2026-07-09T10:00:00.000Z",
        updatedAt: "2026-07-09T10:01:00.000Z",
      },
    ],
    hasMore: false,
    limit: 50,
  },
  previewSessions: { items: [], hasMore: false, limit: 50 },
  recentActivity: { items: [], hasMore: false, limit: 100 },
  limits: {
    maxPromptBytes: 8192,
    maxAttachmentCount: 8,
    maxTerminalInputBytes: 16384,
    maxListItems: 50,
  },
  serverTime: "2026-07-09T10:02:00.000Z",
};

const reviewSummary = {
  id: "rev_live_smoke_1",
  projectId: "proj_1",
  worktreeId: "wt_abcdef123456",
  status: "reviewing",
  pullRequestNumber: 879,
  round: 1,
  maxRounds: 3,
  reviewer: "workspace",
  implementer: "workspace",
  findings: {
    total: 1,
    high: 0,
    medium: 1,
    low: 0,
  },
  safeStatus: "Review running",
  updatedAt: "2026-07-09T10:02:00Z",
};

describe("coding-agent real runtime smoke helper", () => {
  it("normalizes runtime URLs to an HTTP(S) base path and rejects unsafe protocols", () => {
    expect(normalizeRuntimeUrl("https://app.matrix-os.com/vm/test?token=secret").toString()).toBe(
      "https://app.matrix-os.com/vm/test/",
    );
    expect(normalizeRuntimeUrl("http://127.0.0.1:3001").toString()).toBe("http://127.0.0.1:3001/");
    expect(() => normalizeRuntimeUrl("file:///tmp/runtime")).toThrow(/must use http or https/);
  });

  it("builds bearer headers without logging the raw token", () => {
    expect(buildAuthHeaders("secret-token")).toEqual({
      Authorization: "Bearer secret-token",
      Accept: "application/json",
    });
    expect(redactForLog("Authorization: Bearer secret-token")).toBe("Authorization: Bearer [redacted]");
    expect(redactForLog("node smoke --token=secret-token")).toBe("node smoke --token [redacted]");
  });

  it("creates config from flags without accepting missing auth", () => {
    expect(() => createSmokeConfig(["--url", "https://runtime.test"], {})).toThrow(/token is required/);
    expect(() => createSmokeConfig(["--url", "https://runtime.test", "--token", "abc"], {})).toThrow(
      /Use MATRIX_RUNTIME_TOKEN/,
    );
    try {
      createSmokeConfig(["--url", "https://runtime.test", "--token=secret-token"], {});
      throw new Error("expected --token= to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Use MATRIX_RUNTIME_TOKEN");
      expect((err as Error).message).not.toContain("secret-token");
    }
    expect(
      createSmokeConfig(["--url", "https://runtime.test/path", "--project-id", "proj_1"], {
        MATRIX_RUNTIME_TOKEN: "abc",
      }),
    ).toMatchObject({
      runtimeUrl: new URL("https://runtime.test/path/"),
      token: "abc",
      projectId: "proj_1",
    });
  });

  it("validates the summary, thread list, review list, and preferences without exposing body content", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push(String(url));
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
      if (String(url).endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary);
      if (String(url).endsWith("/api/coding-agents/threads")) {
        return jsonResponse({ items: runtimeSummary.activeThreads.items, hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [reviewSummary], hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({
          preferences: {
            attentionPush: {
              approval: true,
              input: true,
              failed: true,
              completed: true,
            },
          },
        });
      }
      throw new Error(`unexpected URL ${String(url)}`);
    });

    const result = await runRuntimeSmoke({
      runtimeUrl: new URL("https://runtime.test/"),
      token: "secret-token",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "runtime summary",
      "thread list",
      "review list",
      "notification preferences",
    ]);
    expect(result.checks.find((check) => check.name === "review list")).toMatchObject({
      detail: "1 reviews",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(calls).toEqual([
      "https://runtime.test/api/coding-agents/summary",
      "https://runtime.test/api/coding-agents/threads",
      "https://runtime.test/api/coding-agents/reviews",
      "https://runtime.test/api/coding-agents/notification-preferences",
    ]);
  });

  it("checks coding-agent routes under an explicit runtime base path", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary);
      if (String(url).endsWith("/api/coding-agents/threads")) {
        return jsonResponse({ items: runtimeSummary.activeThreads.items, hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [], hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({
          preferences: {
            attentionPush: {
              approval: true,
              input: true,
              failed: true,
              completed: true,
            },
          },
        });
      }
      throw new Error(`unexpected URL ${String(url)}`);
    });

    await expect(
      runRuntimeSmoke({
        runtimeUrl: normalizeRuntimeUrl("https://app.matrix-os.com/vm/demo?token=secret"),
        token: "secret-token",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual([
      "https://app.matrix-os.com/vm/demo/api/coding-agents/summary",
      "https://app.matrix-os.com/vm/demo/api/coding-agents/threads",
      "https://app.matrix-os.com/vm/demo/api/coding-agents/reviews",
      "https://app.matrix-os.com/vm/demo/api/coding-agents/notification-preferences",
    ]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  it("normalizes URL object runtime inputs before resolving coding-agent routes", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary);
      if (String(url).endsWith("/api/coding-agents/threads")) {
        return jsonResponse({ items: runtimeSummary.activeThreads.items, hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [], hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({
          preferences: {
            attentionPush: {
              approval: true,
              input: true,
              failed: true,
              completed: true,
            },
          },
        });
      }
      throw new Error(`unexpected URL ${String(url)}`);
    });

    await runRuntimeSmoke({
      runtimeUrl: new URL("https://app.matrix-os.com/vm/demo"),
      token: "secret-token",
      fetchImpl,
    });

    expect(calls[0]).toBe("https://app.matrix-os.com/vm/demo/api/coding-agents/summary");
  });

  it("applies project-scoped summary filtering when configured", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/coding-agents/summary?projectId=proj_1")) return jsonResponse(runtimeSummary);
      if (String(url).endsWith("/api/coding-agents/threads")) {
        return jsonResponse({ items: runtimeSummary.activeThreads.items, hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [], hasMore: false, limit: 50 });
      }
      if (String(url).endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({
          preferences: {
            attentionPush: {
              approval: true,
              input: true,
              failed: true,
              completed: true,
            },
          },
        });
      }
      throw new Error(`unexpected URL ${String(url)}`);
    });

    await runRuntimeSmoke({
      runtimeUrl: new URL("https://runtime.test/"),
      token: "secret-token",
      projectId: "proj_1",
      fetchImpl,
    });

    expect(calls[0]).toBe("https://runtime.test/api/coding-agents/summary?projectId=proj_1");
  });

  it("stops reading oversized streamed responses before parsing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_JSON_BYTES + 1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      runRuntimeSmoke({
        runtimeUrl: new URL("https://runtime.test/"),
        token: "secret-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "SmokeFailure",
      safeMessage: "runtime summary returned too much data. Check runtime limits and try again.",
    });
  });

  it("fails safely when a live endpoint returns invalid schema data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ runtime: { id: "../unsafe" } }));

    await expect(
      runRuntimeSmoke({
        runtimeUrl: new URL("https://runtime.test/"),
        token: "secret-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "SmokeFailure",
      safeMessage: "Runtime summary response did not match the Matrix coding-agent contract.",
    });
    await expect(
      runRuntimeSmoke({
        runtimeUrl: new URL("https://runtime.test/"),
        token: "secret-token",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(SmokeFailure);
  });

  it("rejects unsafe setup commands from provider summaries", async () => {
    const summaryWithUnsafeSetup = {
      ...runtimeSummary,
      providers: [
        {
          ...runtimeSummary.providers[0],
          setupActions: [
            {
              id: "workspace",
              kind: "foreground_terminal",
              label: "Setup",
              command: "cat /home/matrix/secret",
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(summaryWithUnsafeSetup));

    await expect(
      runRuntimeSmoke({
        runtimeUrl: new URL("https://runtime.test/"),
        token: "secret-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "SmokeFailure",
      safeMessage: "Runtime summary response did not match the Matrix coding-agent contract.",
    });
  });

  it("preserves safe uppercase gateway error codes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: "NOT_FOUND" } }, { status: 404 }));

    await expect(
      runRuntimeSmoke({
        runtimeUrl: new URL("https://runtime.test/"),
        token: "secret-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "SmokeFailure",
      safeMessage: "runtime summary failed with NOT_FOUND. Resolve the runtime issue and try again.",
    });
  });
});
