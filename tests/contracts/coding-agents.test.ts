import { describe, expect, it } from "vitest";
import {
  AgentProviderSummarySchema,
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  ApprovalDecisionRequestSchema,
  AgentThreadComposerDraftSchema,
  CreateAgentThreadRequestSchema,
  FileBrowseRequestSchema,
  FileBrowseResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileSearchRequestSchema,
  FileSearchResponseSchema,
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  SourceControlCreatePullRequestRequestSchema,
  SourceControlCreatePullRequestResponseSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  FileMetadataSchema,
  PreviewSessionSummarySchema,
  ReviewDiffLineSchema,
  ReviewFileDiffSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  SafeAssistantPreviewSourceTextSchema,
  SafeAssistantPreviewTextSchema,
  SafeClientErrorSchema,
  TerminalClientFrameSchema,
  TerminalServerFrameSchema,
  TerminalSessionSummarySchema,
  ThreadIdSchema,
  UserInputAnswerRequestSchema,
  UserInputRequestSchema,
  buildCreateAgentThreadRequestFromComposer,
  defaultAgentThreadComposerDraft,
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

  it("rejects unsafe assistant preview text before shell display", () => {
    expect(SafeAssistantPreviewTextSchema.parse("Reviewed the route test and updated the focused assertion.")).toBe(
      "Reviewed the route test and updated the focused assertion.",
    );
    expect(SafeAssistantPreviewSourceTextSchema.parse("Reviewed the full source text before capping.")).toBe(
      "Reviewed the full source text before capping.",
    );

    for (const unsafePreview of [
      "Read /opt/matrix/app/BUNDLE_VERSION from the host.",
      "Opened /Users/alice/.ssh/config while debugging.",
      "postgres://matrix:secret@db.internal/app failed",
      "Anthropic returned a provider stack trace.",
      "OpenAI request failed with token details.",
      "Use password=hunter2 for the test account.",
      "JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature was printed.",
      "GitHub token ghp_1234567890abcdef1234567890abcdef1234 failed.",
      `GitHub token ${["github", "pat", "1234567890abcdef", "1234567890abcdef1234567890abcdef"].join("_")} failed.`,
      "GitLab token glpat-1234567890abcdef1234 failed.",
      "Slack token xoxb-1234567890-abcdef failed.",
      `Stripe key ${["sk", "live", "1234567890abcdef1234567890abcdef"].join("_")} failed.`,
      "AWS key AKIAIOSFODNN7EXAMPLE failed.",
    ]) {
      expect(() => SafeAssistantPreviewTextSchema.parse(unsafePreview)).toThrow();
    }

    const boundaryToken = `${"Reviewed safe progress. ".repeat(12)}ghp_1234567890abcdef1234567890abcdef1234`;
    expect(() => SafeAssistantPreviewSourceTextSchema.parse(boundaryToken)).toThrow();
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
      attentionThreads: {
        items: [
          {
            id: "thread_attention",
            providerId: "codex",
            title: "Approve deployment",
            status: "waiting_for_approval",
            attention: "approval_required",
            createdAt: now,
            updatedAt: now,
          },
        ],
        hasMore: false,
        limit: 20,
      },
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

    expect(summary.attentionThreads.items[0]).toMatchObject({
      id: "thread_attention",
      attention: "approval_required",
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
    const promptWithWhitespace = "  cat <<'EOF'\n  keep indentation\nEOF\n";
    expect(CreateAgentThreadRequestSchema.parse({
      providerId: "codex",
      prompt: promptWithWhitespace,
      clientRequestId: "req_preserve",
    }).prompt).toBe(promptWithWhitespace);
    expect(CreateAgentThreadRequestSchema.parse({
      providerId: "codex",
      prompt: "Use the selected worktree.",
      worktreeId: "wt_abc123def456",
      clientRequestId: "req_worktree",
    }).worktreeId).toBe("wt_abc123def456");
    expect(() =>
      CreateAgentThreadRequestSchema.parse({
        providerId: "codex",
        prompt: "Use a worktree.",
        worktreeId: "WT_bad:ref",
        clientRequestId: "req_worktree",
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
    expect(AgentThreadEventSchema.parse({
      type: "user_input.answered",
      eventId: "evt_answered",
      threadId: "thread_1",
      occurredAt: now,
      requestId: "req_answer",
      correlationId: "corr_answer",
    }).type).toBe("user_input.answered");
    expect(AgentThreadSnapshotSchema.parse({
      thread: {
        id: "thread_1",
        providerId: "codex",
        title: "Fix tests",
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
      events: {
        items: [
          {
            type: "thread.status",
            eventId: "evt_snapshot",
            threadId: "thread_1",
            occurredAt: now,
            status: "running",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    }).events.items[0]?.type).toBe("thread.status");
    expect(() =>
      AgentThreadSnapshotSchema.parse({
        thread: {
          id: "thread_1",
          providerId: "codex",
          title: "Fix tests",
          status: "running",
          createdAt: now,
          updatedAt: now,
        },
        events: {
          items: [{ rawProviderPayload: "do not accept unknown event shapes" }],
          hasMore: false,
          limit: 200,
        },
      }),
    ).toThrow();

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

  it("validates coding-agent notification preferences without accepting extra payload data", () => {
    expect(CodingAgentNotificationPreferencesSchema.parse({
      attentionPush: {
        approval: true,
        input: false,
        failed: true,
        completed: true,
      },
    })).toEqual({
      attentionPush: {
        approval: true,
        input: false,
        failed: true,
        completed: true,
      },
    });

    expect(CodingAgentNotificationPreferencesUpdateSchema.parse({
      attentionPush: {
        approval: false,
        input: false,
        failed: false,
        completed: false,
      },
    }).attentionPush.completed).toBe(false);

    expect(() =>
      CodingAgentNotificationPreferencesSchema.parse({
        attentionPush: {
          approval: true,
          input: true,
          failed: true,
          completed: true,
          provider: "raw",
        },
      }),
    ).toThrow();
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
    const answerWithWhitespace = "\n  keep this exact answer  \n";
    expect(UserInputAnswerRequestSchema.parse({
      answer: answerWithWhitespace,
      clientRequestId: "req_answer_preserve",
      correlationId: "corr_answer",
    }).answer).toBe(answerWithWhitespace);

    const structuredRequest = UserInputRequestSchema.parse({
      requestId: "req_input_structured",
      threadId: "thread_input_structured",
      title: "Choose an approach",
      safeDescription: "The coding agent needs two decisions before continuing.",
      required: true,
      autoResolutionMs: 120_000,
      correlationId: "corr_input_structured",
      questions: [
        {
          questionId: "implementation",
          header: "Approach",
          question: "Which implementation should be used?",
          options: [
            { label: "Minimal", description: "Change only the required code." },
            { label: "Complete", description: "Include the related migration." },
          ],
          allowOther: true,
          secret: false,
        },
        {
          questionId: "confirmation",
          header: "Confirm",
          question: "Should the coding agent continue?",
          secret: false,
        },
      ],
    });
    expect(structuredRequest.questions).toHaveLength(2);

    const structuredAnswer = UserInputAnswerRequestSchema.parse({
      answer: "Submitted structured response.",
      structuredAnswers: {
        implementation: ["Minimal"],
        confirmation: ["Yes"],
      },
      clientRequestId: "req_answer_structured",
      correlationId: "corr_input_structured",
    });
    expect(structuredAnswer.structuredAnswers?.implementation).toEqual(["Minimal"]);

    const maximumStructuredAnswer = UserInputAnswerRequestSchema.parse({
      answer: "a".repeat(8000),
      structuredAnswers: Object.fromEntries(
        Array.from({ length: 8 }, (_, questionIndex) => [
          `question_${questionIndex}`,
          Array.from({ length: 4 }, () => "a".repeat(400)),
        ]),
      ),
      clientRequestId: "req_answer_maximum",
      correlationId: "corr_input_structured",
    });
    expect(Buffer.byteLength(JSON.stringify(maximumStructuredAnswer), "utf8")).toBeLessThanOrEqual(40 * 1024);

    const maximumLegacyAnswer = UserInputAnswerRequestSchema.parse({
      answer: "a".repeat(32_000),
      clientRequestId: "req_answer_legacy_maximum",
      correlationId: "corr_input_structured",
    });
    expect(maximumLegacyAnswer.answer).toHaveLength(32_000);
    expect(Buffer.byteLength(JSON.stringify(maximumLegacyAnswer), "utf8")).toBeLessThanOrEqual(40 * 1024);

    const escapedStructuredAnswer = {
      answer: "\\".repeat(8000),
      structuredAnswers: Object.fromEntries(
        Array.from({ length: 8 }, (_, questionIndex) => [
          `question_${questionIndex}`,
          Array.from({ length: 4 }, () => "\\".repeat(400)),
        ]),
      ),
      clientRequestId: "req_answer_escaped",
      correlationId: "corr_input_structured",
    };
    expect(Buffer.byteLength(JSON.stringify(escapedStructuredAnswer), "utf8")).toBeGreaterThan(40 * 1024);
    expect(() => UserInputAnswerRequestSchema.parse(escapedStructuredAnswer)).toThrow();

    expect(() => UserInputRequestSchema.parse({
      ...structuredRequest,
      questions: [structuredRequest.questions![0], structuredRequest.questions![0]],
    })).toThrow();
    expect(() => UserInputAnswerRequestSchema.parse({
      answer: "Submitted structured response.",
      structuredAnswers: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`question_${index}`, ["answer"]]),
      ),
      clientRequestId: "req_answer_too_many",
      correlationId: "corr_input_structured",
    })).toThrow();
    expect(() => UserInputAnswerRequestSchema.parse({
      answer: "Submitted structured response.",
      structuredAnswers: { implementation: ["a".repeat(401)] },
      clientRequestId: "req_answer_too_large",
      correlationId: "corr_input_structured",
    })).toThrow();

    expect(FileMetadataSchema.parse({
      path: "src/index.ts",
      kind: "file",
      sizeBytes: 512,
      etag: "etag_123",
      updatedAt: now,
    }).path).toBe("src/index.ts");
    expect(() => FileMetadataSchema.parse({ path: "../secret", kind: "file" })).toThrow();

    expect(FileReadRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "src/index.ts",
    }).path).toBe("src/index.ts");
    expect(() => FileReadRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
    })).toThrow();
    expect(FileReadResponseSchema.parse({
      metadata: {
        path: "src/index.ts",
        kind: "file",
        sizeBytes: 27,
        etag: "sha256_123",
        updatedAt: now,
      },
      content: "export const answer = 42;\n",
      encoding: "utf8",
      truncated: false,
      limitBytes: 65536,
    }).truncated).toBe(false);
    expect(FileWriteRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "src/index.ts",
      content: "export const answer = 43;\n",
      encoding: "utf8",
      baseEtag: "sha256_123",
      clientRequestId: "req_file_write",
    }).baseEtag).toBe("sha256_123");
    expect(FileWriteRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "src/new.ts",
      content: "export {};\n",
      encoding: "utf8",
      baseEtag: null,
      clientRequestId: "req_file_create",
    }).baseEtag).toBeNull();
    expect(() => FileWriteRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
      content: "unsafe",
      encoding: "utf8",
      baseEtag: null,
      clientRequestId: "req_file_bad_path",
    })).toThrow();
    expect(FileWriteResponseSchema.parse({
      metadata: {
        path: "src/index.ts",
        kind: "file",
        sizeBytes: 27,
        etag: "sha256_456",
        updatedAt: now,
      },
      encoding: "utf8",
      writtenBytes: 27,
    }).writtenBytes).toBe(27);
    expect(FileBrowseRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "src",
      limit: 20,
    }).path).toBe("src");
    expect(FileBrowseRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
    }).path).toBeUndefined();
    expect(() => FileBrowseRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system",
    })).toThrow();
    expect(FileBrowseResponseSchema.parse({
      directory: {
        path: "src",
        kind: "directory",
      },
      entries: {
        items: [{
          path: "src/index.ts",
          kind: "file",
          sizeBytes: 27,
          etag: "sha256_123",
          updatedAt: now,
        }],
        hasMore: false,
        limit: 20,
      },
    }).entries.items[0]?.path).toBe("src/index.ts");
    expect(FileSearchRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: "index",
      path: "src",
      limit: 20,
    }).query).toBe("index");
    expect(FileSearchRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: "bearer-token.test.ts",
    }).query).toBe("bearer-token.test.ts");
    expect(() => FileSearchRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: " ",
    })).toThrow();
    expect(FileSearchResponseSchema.parse({
      matches: {
        items: [{ path: "src/index.ts", kind: "file", sizeBytes: 27 }],
        hasMore: false,
        limit: 20,
      },
    }).matches.items).toHaveLength(1);

    expect(SourceControlPrepareCommitRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files\n\nInclude the detailed review notes for src/index.ts.",
      paths: ["src/index.ts"],
      clientRequestId: "req_prepare_commit",
    }).message).toContain("detailed review notes");
    expect(SourceControlPrepareCommitRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      clientRequestId: "req_prepare_commit_all",
    }).paths).toBeUndefined();
    expect(() => SourceControlPrepareCommitRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix:\u0000 update reviewed files",
      clientRequestId: "req_prepare_commit_unsafe",
    })).toThrow();
    expect(() => SourceControlPrepareCommitRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["../secret.txt"],
      clientRequestId: "req_prepare_commit_bad_path",
    })).toThrow();
    expect(SourceControlPrepareCommitResponseSchema.parse({
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/var/review-fix",
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    }).branch).toBe("feature/var/review-fix");
    expect(SourceControlPrepareCommitResponseSchema.parse({
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef012345670123456789abcdef01234567",
      branch: "detached",
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    }).commitSha).toHaveLength(64);
    expect(SourceControlPrepareCommitResponseSchema.parse({
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: `feature/${"a".repeat(220)}`,
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    }).branch).toHaveLength(228);
    expect(SourceControlCreatePullRequestRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: update reviewed files",
      body: "Review updates are ready.",
      baseBranch: "main",
      draft: true,
      clientRequestId: "req_create_pull_request",
    }).draft).toBe(true);
    expect(SourceControlCreatePullRequestRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: update reviewed files",
      clientRequestId: "req_create_pull_request_default",
    }).body).toBeUndefined();
    expect(() => SourceControlCreatePullRequestRequestSchema.parse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix:\u0000 update reviewed files",
      clientRequestId: "req_create_pull_request_bad_title",
    })).toThrow();
    expect(SourceControlCreatePullRequestRequestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: update reviewed files",
      clientRequestId: "req_create_pull_request_leak",
      accessToken: "secret",
    }).success).toBe(false);
    expect(SourceControlCreatePullRequestResponseSchema.parse({
      status: "created",
      number: 807,
      url: "https://github.com/HamedMP/matrix-os/pull/807",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    }).number).toBe(807);
    expect(SourceControlCreatePullRequestResponseSchema.parse({
      status: "existing",
      number: 808,
      url: "https://github.com/HamedMP/matrix-os/pull/808",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    }).status).toBe("existing");
    expect(() => SourceControlCreatePullRequestResponseSchema.parse({
      status: "created",
      number: 807,
      url: "https://internal.example.test/HamedMP/matrix-os/pull/807",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    })).toThrow();

    expect(ReviewSummarySchema.parse({
      id: "rev_123",
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      status: "reviewing",
      pullRequestNumber: 757,
      round: 1,
      maxRounds: 3,
      reviewer: "codex",
      implementer: "claude",
      findings: {
        total: 2,
        high: 1,
        medium: 1,
        low: 0,
      },
      updatedAt: now,
    }).findings.total).toBe(2);
    expect(() =>
      ReviewSummarySchema.parse({
        id: "rev_123",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        safeStatus: "Postgres failed at /home/matrix/home",
        updatedAt: now,
      }),
    ).toThrow();

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

    const reviewSnapshot = ReviewSnapshotSchema.parse({
      review: {
        id: "rev_123",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        updatedAt: now,
      },
      files: {
        items: [
          {
            path: "src/index.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [
              {
                id: "hunk_rev_123_0_0",
                oldStart: 12,
                oldLines: 1,
                newStart: 12,
                newLines: 1,
                heading: "Finding HIGH-1",
                partial: true,
                lines: [
                  {
                    kind: "remove",
                    oldLine: 12,
                    content: "const unsafe = true;",
                  },
                  {
                    kind: "add",
                    newLine: 12,
                    content: "const safe = true;",
                  },
                ],
              },
            ],
            findings: [
              {
                id: "HIGH-1",
                severity: "high",
                line: 12,
                summary: "Validate the request before reading review state.",
              },
            ],
          },
        ],
        hasMore: false,
        limit: 100,
      },
      partial: true,
      safeNotice: "Diff content is not available yet. Showing bounded review findings.",
      updatedAt: now,
    });
    expect(reviewSnapshot.files.items[0]?.hunks[0]?.partial).toBe(true);
    expect(reviewSnapshot.files.items[0]?.hunks[0]?.lines?.[1]).toMatchObject({
      kind: "add",
      newLine: 12,
      content: "const safe = true;",
    });
    expect(ReviewDiffLineSchema.parse({
      kind: "context",
      oldLine: 14,
      newLine: 14,
      content: "return value;",
    }).kind).toBe("context");
    expect(() =>
      ReviewDiffLineSchema.parse({
        kind: "add",
        newLine: 1,
        content: "x".repeat(1001),
      }),
    ).toThrow();
    expect(() =>
      ReviewDiffLineSchema.parse({
        kind: "context",
        oldLine: 0,
        newLine: 1,
        content: "return value;",
      }),
    ).toThrow();
    expect(() =>
      ReviewSnapshotSchema.parse({
        ...reviewSnapshot,
        files: {
          ...reviewSnapshot.files,
          items: [{ ...reviewSnapshot.files.items[0], path: "../secret.ts" }],
        },
      }),
    ).toThrow();
    expect(() =>
      ReviewSnapshotSchema.parse({
        ...reviewSnapshot,
        files: {
          ...reviewSnapshot.files,
          items: [{
            ...reviewSnapshot.files.items[0],
            findings: [{
              ...reviewSnapshot.files.items[0]!.findings![0],
              summary: "Postgres failed at /home/matrix/home",
            }],
          }],
        },
      }),
    ).toThrow();

    expect(PreviewSessionSummarySchema.parse({
      id: "preview_main",
      projectId: "repo-main",
      label: "Development preview",
      status: "running",
      origin: `https://preview.example.com/${"a".repeat(700)}?token=${"b".repeat(700)}`,
      updatedAt: now,
    }).status).toBe("running");

    expect(TerminalServerFrameSchema.parse({
      type: "attached",
      session: "main",
      state: "running",
      fromSeq: 0,
    }).type).toBe("attached");
    expect(TerminalServerFrameSchema.parse({
      type: "attached",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      state: "running",
    }).type).toBe("attached");
    expect(TerminalServerFrameSchema.parse({ type: "replay-start", fromSeq: 0 }).type).toBe("replay-start");
    expect(TerminalServerFrameSchema.parse({ type: "replay-end", toSeq: null }).type).toBe("replay-end");
    expect(TerminalServerFrameSchema.parse({ type: "replay-evicted", fromSeq: 0, nextSeq: 10 }).type).toBe("replay-evicted");
    expect(TerminalServerFrameSchema.parse({
      type: "error",
      code: "invalid_message",
      message: "Invalid message",
    }).type).toBe("error");
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

  it("builds a create-thread request from a safe composer draft", () => {
    const summary = RuntimeSummarySchema.parse({
      runtime: {
        id: "rt_primary",
        label: "Primary Matrix computer",
        status: "available",
      },
      capabilities: [
        { id: "codingAgentsRuntimeSummary", enabled: true },
        { id: "codingAgentsThreadCreate", enabled: true },
      ],
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          kind: "codex",
          availability: "available",
          installStatus: "installed",
          authStatus: "authenticated",
          supportedModes: ["default", "review"],
          defaultMode: "review",
          setupActions: [],
          lastCheckedAt: now,
        },
      ],
      projects: { items: [], hasMore: false, limit: 20 },
      activeThreads: { items: [], hasMore: false, limit: 20 },
      terminalSessions: { items: [], hasMore: false, limit: 20 },
      recentActivity: { items: [], hasMore: false, limit: 30 },
      limits: {
        maxPromptBytes: 24000,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 65536,
        maxListItems: 50,
      },
      serverTime: now,
    });
    const draft = AgentThreadComposerDraftSchema.parse({
      prompt: "  keep exact prompt whitespace\n",
      projectId: "repo-main",
      terminalSessionId: "main",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });

    expect(defaultAgentThreadComposerDraft(summary)).toMatchObject({
      providerId: "codex",
      mode: "review",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });
    const result = buildCreateAgentThreadRequestFromComposer({
      draft,
      summary,
      clientRequestId: "req_create_from_composer",
    });

    expect(result).toEqual({
      ok: true,
      request: {
        providerId: "codex",
        prompt: "  keep exact prompt whitespace\n",
        projectId: "repo-main",
        terminalSessionId: "main",
        mode: "review",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_create_from_composer",
      },
    });
  });

  it("returns safe composer issues for unavailable or invalid create inputs", () => {
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
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          kind: "codex",
          availability: "auth_required",
          installStatus: "installed",
          authStatus: "expired",
          supportedModes: ["default"],
          defaultMode: "default",
          setupActions: [],
          lastCheckedAt: now,
        },
      ],
      projects: { items: [], hasMore: false, limit: 20 },
      activeThreads: { items: [], hasMore: false, limit: 20 },
      terminalSessions: { items: [], hasMore: false, limit: 20 },
      recentActivity: { items: [], hasMore: false, limit: 30 },
      limits: {
        maxPromptBytes: 24000,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 65536,
        maxListItems: 50,
      },
      serverTime: now,
    });

    const result = buildCreateAgentThreadRequestFromComposer({
      draft: {
        providerId: "codex",
        prompt: "   ",
        mode: "review",
      },
      summary,
      clientRequestId: "req_bad_composer",
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "thread_create_unavailable",
          safeMessage: "Agent runs are not available on this runtime yet.",
        },
        {
          code: "prompt_required",
          safeMessage: "Enter a prompt before starting an agent run.",
        },
        {
          code: "provider_unavailable",
          safeMessage: "Selected provider is not ready. Choose another provider or finish setup.",
        },
        {
          code: "mode_unsupported",
          safeMessage: "Selected mode is not supported by this provider.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/zod|stack trace|\/home\/|token|secret/i);
  });
});
