import { describe, expect, it } from "vitest";
import {
  AgentProviderSummarySchema,
  AgentThreadEventSchema,
  ApprovalDecisionRequestSchema,
  CreateAgentThreadRequestSchema,
  FileMetadataSchema,
  PreviewSessionSummarySchema,
  ReviewFileDiffSchema,
  RuntimeSummarySchema,
  SafeClientErrorSchema,
  TerminalClientFrameSchema,
  TerminalServerFrameSchema,
  TerminalSessionSummarySchema,
  ThreadIdSchema,
  UserInputAnswerRequestSchema,
} from "../../packages/contracts/src/index.js";

const now = "2026-07-06T12:00:00.000Z";

describe("coding agent contracts", () => {
  it("rejects unsafe identifiers and unsafe client error text", () => {
    expect(ThreadIdSchema.parse("thread_abc-123")).toBe("thread_abc-123");
    expect(() => ThreadIdSchema.parse("../thread_abc")).toThrow();
    expect(() => ThreadIdSchema.parse("thread_")).toThrow();

    expect(SafeClientErrorSchema.parse({
      code: "runtime_unavailable",
      safeMessage: "Workspace is temporarily unavailable. Try again.",
      retryable: true,
      recoveryActions: ["retry"],
    })).toEqual({
      code: "runtime_unavailable",
      safeMessage: "Workspace is temporarily unavailable. Try again.",
      retryable: true,
      recoveryActions: ["retry"],
    });

    expect(() =>
      SafeClientErrorSchema.parse({
        code: "server_error",
        safeMessage: "Postgres constraint failed in /home/matrix/project",
        retryable: false,
      }),
    ).toThrow();
  });

  it("parses bounded runtime summaries without sensitive runtime data", () => {
    const summary = RuntimeSummarySchema.parse({
      runtime: {
        id: "rt_primary",
        label: "Primary Matrix computer",
        status: "available",
      },
      capabilities: [
        { id: "codingAgentsRuntimeSummary", enabled: true },
        { id: "codingAgentsThreadCreate", enabled: false, reason: "Not enabled yet" },
      ],
      providers: [],
      projects: { items: [], hasMore: false, limit: 20 },
      activeThreads: { items: [], hasMore: false, limit: 20 },
      terminalSessions: {
        items: [
          {
            id: "term_main",
            name: "main",
            status: "running",
            attachable: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        hasMore: false,
        limit: 20,
      },
      recentActivity: { items: [], hasMore: false, limit: 30 },
      limits: {
        maxPromptBytes: 24000,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 65536,
        maxListItems: 50,
      },
      serverTime: now,
    });

    expect(summary.terminalSessions.items[0]?.attachable).toBe(true);
    expect(() =>
      RuntimeSummarySchema.parse({
        ...summary,
        terminalOutput: "secret output",
      }),
    ).toThrow();
  });

  it("validates providers, thread creation, events, approvals, and terminal frames", () => {
    expect(AgentProviderSummarySchema.parse({
      id: "codex",
      displayName: "Codex",
      kind: "codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default", "review"],
      defaultMode: "default",
      setupActions: [],
      lastCheckedAt: now,
    }).id).toBe("codex");

    expect(() =>
      AgentProviderSummarySchema.parse({
        id: "bad provider",
        displayName: "/tmp/provider.log",
        kind: "custom",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [{ id: "setup", label: "Run setup", kind: "raw_command", command: "cat ~/.ssh/id_rsa" }],
      }),
    ).toThrow();

    expect(CreateAgentThreadRequestSchema.parse({
      providerId: "codex",
      prompt: "Fix the failing gateway tests.",
      clientRequestId: "req_123",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    }).providerId).toBe("codex");
    expect(() =>
      CreateAgentThreadRequestSchema.parse({
        providerId: "codex",
        prompt: "",
        clientRequestId: "req_123",
      }),
    ).toThrow();

    expect(AgentThreadEventSchema.parse({
      type: "approval.requested",
      eventId: "evt_1",
      threadId: "thread_1",
      occurredAt: now,
      approval: {
        approvalId: "appr_1",
        threadId: "thread_1",
        title: "Approve command",
        safeDescription: "The agent wants to run a workspace command.",
        risk: "medium",
        actionKind: "command",
        allowedDecisions: ["approve", "decline"],
        correlationId: "corr_1",
      },
    }).type).toBe("approval.requested");

    expect(TerminalClientFrameSchema.parse({ type: "resize", cols: 120, rows: 40 })).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
    expect(() => TerminalClientFrameSchema.parse({ type: "resize", cols: 2000, rows: 40 })).toThrow();

    expect(TerminalSessionSummarySchema.parse({
      id: "term_main",
      name: "main",
      status: "running",
      attachable: true,
      createdAt: now,
      updatedAt: now,
    }).status).toBe("running");
  });

  it("validates decision, input, file, review, preview, and server frame contracts", () => {
    expect(ApprovalDecisionRequestSchema.parse({
      decision: "approve",
      clientRequestId: "req_approve",
      correlationId: "corr_approve",
    }).decision).toBe("approve");

    expect(UserInputAnswerRequestSchema.parse({
      answer: "Please continue with the safer implementation.",
      clientRequestId: "req_answer",
      correlationId: "corr_answer",
    }).answer).toBe("Please continue with the safer implementation.");

    expect(FileMetadataSchema.parse({
      path: "src/index.ts",
      kind: "file",
      sizeBytes: 512,
      etag: "etag_123",
      updatedAt: now,
    }).path).toBe("src/index.ts");
    expect(() => FileMetadataSchema.parse({ path: "../secret", kind: "file" })).toThrow();

    expect(ReviewFileDiffSchema.parse({
      path: "src/index.ts",
      status: "modified",
      additions: 12,
      deletions: 4,
      partial: true,
    }).partial).toBe(true);
    expect(() =>
      ReviewFileDiffSchema.parse({
        path: "src/index.ts",
        status: "modified",
        additions: 1_000_001,
        deletions: 0,
        partial: false,
      }),
    ).toThrow();

    expect(PreviewSessionSummarySchema.parse({
      id: "preview_main",
      label: "Development preview",
      status: "running",
      origin: "https://preview.example.com",
      updatedAt: now,
    }).status).toBe("running");

    expect(TerminalServerFrameSchema.parse({
      type: "safe-error",
      error: {
        code: "session_unavailable",
        safeMessage: "Terminal session is unavailable. Start a new session.",
        retryable: false,
        recoveryActions: ["start_new_session"],
      },
    }).type).toBe("safe-error");
  });
});
