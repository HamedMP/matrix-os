import { describe, expect, it } from "vitest";
import {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  type InvokeChannel,
} from "@desktop/shared/ipc-contract";
import type { CreateAgentThreadRequest } from "@matrix-os/contracts";

describe("IPC contract", () => {
  it("defines every invoke channel from the contract doc", () => {
    const expected: InvokeChannel[] = [
      "auth:start-device-flow",
      "auth:poll",
      "auth:status",
      "auth:sign-out",
      "runtime:create-thread",
      "runtime:get-notification-preferences",
      "runtime:update-notification-preferences",
      "runtime:submit-approval-decision",
      "runtime:submit-input-answer",
      "runtime:get-thread-snapshot",
      "runtime:browse-files",
      "runtime:search-files",
      "runtime:get-file-content",
      "runtime:save-file-content",
      "runtime:prepare-source-commit",
      "runtime:get-review-snapshot",
      "runtime:get-reviews",
      "runtime:get-summary",
      "runtime:select",
      "state:get",
      "state:set",
      "embed:open",
      "embed:set-bounds",
      "embed:close",
      "embed:retry-auth",
      "notify",
      "badge:set",
      "shell:open-external",
      "update:check",
    ];
    for (const ch of expected) {
      expect(INVOKE_CHANNELS[ch], ch).toBeDefined();
    }
  });

  it("validates runtime:create-thread requests and rejects credential leakage shapes", () => {
    const request: CreateAgentThreadRequest = {
      providerId: "codex",
      prompt: "Summarize the failing checks",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      clientRequestId: "req_desktop_1",
    };

    expect(INVOKE_CHANNELS["runtime:create-thread"].request.safeParse(request).success).toBe(true);
    expect(
      INVOKE_CHANNELS["runtime:create-thread"].request.safeParse({ ...request, accessToken: "secret" }).success,
    ).toBe(false);
    expect(
      INVOKE_CHANNELS["runtime:create-thread"].response.safeParse({
        thread: {
          id: "thread_desktop_1",
          providerId: "codex",
          title: "Summarize the failing checks",
          status: "queued",
          attention: "none",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
        events: {
          items: [],
          hasMore: false,
          limit: 200,
        },
      }).success,
    ).toBe(true);
  });

  it("validates runtime:get-thread-snapshot requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:get-thread-snapshot"].request;
    const schema = INVOKE_CHANNELS["runtime:get-thread-snapshot"].response;
    const valid = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "waiting_for_approval",
        attention: "approval_required",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:01:00.000Z",
      },
      events: {
        items: [
          {
            type: "approval.requested",
            eventId: "evt_approval_1",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:01:00.000Z",
            approval: {
              approvalId: "appr_desktop_1",
              threadId: "thread_desktop_1",
              actionKind: "command",
              risk: "medium",
              title: "Run tests",
              safeDescription: "Run the focused desktop tests.",
              allowedDecisions: ["approve", "decline"],
              correlationId: "corr_desktop_1",
            },
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };

    expect(requestSchema.safeParse({ threadId: "thread_desktop_1" }).success).toBe(true);
    expect(requestSchema.safeParse({ threadId: "../secret" }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      thread: { ...valid.thread, providerSecret: "secret" },
    }).success).toBe(false);
  });

  it("validates runtime:submit-approval-decision requests and responses", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:submit-approval-decision"].request;
    const responseSchema = INVOKE_CHANNELS["runtime:submit-approval-decision"].response;
    const request = {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      decision: "approve",
      correlationId: "corr_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, providerToken: "secret" }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, approvalId: "../secret" }).success).toBe(false);
    expect(responseSchema.safeParse({
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
      events: {
        items: [
          {
            type: "approval.resolved",
            eventId: "evt_approval_2",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:02:00.000Z",
            approvalId: "appr_desktop_1",
            decision: "approve",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    }).success).toBe(true);
  });

  it("validates runtime:submit-input-answer requests and responses", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:submit-input-answer"].request;
    const responseSchema = INVOKE_CHANNELS["runtime:submit-input-answer"].response;
    const request = {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      answer: "Run the focused desktop test.",
      correlationId: "corr_input_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, providerToken: "secret" }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, inputRequestId: "../secret" }).success).toBe(false);
    expect(responseSchema.safeParse({
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      events: {
        items: [
          {
            type: "user_input.answered",
            eventId: "evt_input_2",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:03:00.000Z",
            requestId: "req_input_desktop_1",
            correlationId: "corr_input_desktop_1",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    }).success).toBe(true);
  });

  it("validates runtime:get-summary responses and rejects credential leakage shapes", () => {
    const schema = INVOKE_CHANNELS["runtime:get-summary"].response;
    const valid = {
      runtime: {
        id: "rt_primary",
        label: "Primary",
        status: "available",
      },
      capabilities: [
        {
          id: "codingAgentsRuntimeSummary",
          enabled: true,
        },
      ],
      providers: [],
      projects: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      activeThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      terminalSessions: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      recentActivity: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      limits: {
        maxPromptBytes: 16384,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 8192,
        maxListItems: 20,
      },
      serverTime: "2026-07-06T00:00:00.000Z",
    };

    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
  });

  it("validates notification preference IPC without credential fields", () => {
    const getSchema = INVOKE_CHANNELS["runtime:get-notification-preferences"].response;
    const updateRequestSchema = INVOKE_CHANNELS["runtime:update-notification-preferences"].request;
    const updateResponseSchema = INVOKE_CHANNELS["runtime:update-notification-preferences"].response;

    expect(getSchema.safeParse({ attentionPush: { approval: true, input: true, failed: false } }).success).toBe(true);
    expect(getSchema.safeParse({ attentionPush: { approval: true, input: true, failed: false }, accessToken: "secret" }).success).toBe(false);
    expect(updateRequestSchema.safeParse({ attentionPush: { approval: false, input: true, failed: true } }).success).toBe(true);
    expect(updateRequestSchema.safeParse({ attentionPush: { approval: false, input: true, failed: true }, bearerToken: "secret" }).success).toBe(false);
    expect(updateResponseSchema.safeParse({ attentionPush: { approval: false, input: true, failed: true } }).success).toBe(true);
  });

  it("validates runtime:get-reviews responses and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:get-reviews"].request;
    const schema = INVOKE_CHANNELS["runtime:get-reviews"].response;
    const valid = {
      items: [
        {
          id: "rev_desktop_1",
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          status: "reviewing",
          pullRequestNumber: 757,
          round: 1,
          maxRounds: 3,
          reviewer: "codex",
          implementer: "claude",
          findings: { total: 1, high: 0, medium: 1, low: 0 },
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    };

    expect(requestSchema.safeParse({ cursor: "rev_desktop_1" }).success).toBe(true);
    expect(requestSchema.safeParse({ cursor: "../secret" }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      items: [{ ...valid.items[0], safeStatus: "Postgres failed at /home/matrix/home" }],
    }).success).toBe(false);
  });

  it("validates runtime:get-review-snapshot responses and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:get-review-snapshot"].request;
    const schema = INVOKE_CHANNELS["runtime:get-review-snapshot"].response;
    const valid = {
      review: {
        id: "rev_desktop_1",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        findings: { total: 1, high: 1, medium: 0, low: 0 },
        updatedAt: "2026-07-06T00:00:00.000Z",
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
                id: "hunk_rev_desktop_1_0_0",
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
                summary: "Validate ownership before returning snapshots.",
              },
            ],
          },
        ],
        hasMore: false,
        limit: 100,
      },
      partial: true,
      safeNotice: "Diff content is not available yet. Showing bounded review findings.",
      updatedAt: "2026-07-06T00:00:00.000Z",
    };

    expect(requestSchema.safeParse({ reviewId: "rev_desktop_1" }).success).toBe(true);
    expect(requestSchema.safeParse({ reviewId: "../secret" }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      files: {
        ...valid.files,
        items: [{ ...valid.files.items[0], path: "/home/matrix/private/secret.ts" }],
      },
    }).success).toBe(false);
  });

  it("validates runtime:get-file-content requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:get-file-content"].request;
    const schema = INVOKE_CHANNELS["runtime:get-file-content"].response;
    const valid = {
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 37,
        etag: "sha256_desktop_file",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      content: "export const safeRoute = true;\n",
      encoding: "utf8",
      truncated: false,
      limitBytes: 65536,
    };

    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    }).success).toBe(true);
    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
    }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      metadata: { ...valid.metadata, path: "/home/matrix/private/secret.ts" },
    }).success).toBe(false);
  });

  it("validates runtime:browse-files requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:browse-files"].request;
    const schema = INVOKE_CHANNELS["runtime:browse-files"].response;
    const valid = {
      directory: {
        path: "packages",
        kind: "directory",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      entries: {
        items: [
          {
            path: "packages/gateway",
            kind: "directory",
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };

    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      limit: 20,
    }).success).toBe(true);
    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
    }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      entries: {
        ...valid.entries,
        items: [{ ...valid.entries.items[0], path: "/home/matrix/private" }],
      },
    }).success).toBe(false);
  });

  it("validates runtime:search-files requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:search-files"].request;
    const schema = INVOKE_CHANNELS["runtime:search-files"].response;
    const valid = {
      matches: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            kind: "file",
            sizeBytes: 37,
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };

    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      query: "routes",
      limit: 20,
    }).success).toBe(true);
    expect(requestSchema.safeParse({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
      query: "routes",
    }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, accessToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      matches: {
        ...valid.matches,
        items: [{ ...valid.matches.items[0], path: "/home/matrix/private/secret.ts" }],
      },
    }).success).toBe(false);
  });

  it("validates runtime:save-file-content requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:save-file-content"].request;
    const schema = INVOKE_CHANNELS["runtime:save-file-content"].response;
    const request = {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    };
    const response = {
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 38,
        etag: "sha256_desktop_file_next",
        updatedAt: "2026-07-06T00:04:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 38,
    };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, accessToken: "secret" }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, path: "../system/config.json" }).success).toBe(false);
    expect(schema.safeParse(response).success).toBe(true);
    expect(schema.safeParse({ ...response, bearerToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({
      ...response,
      metadata: { ...response.metadata, path: "/home/matrix/private/secret.ts" },
    }).success).toBe(false);
  });

  it("validates runtime:prepare-source-commit requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:prepare-source-commit"].request;
    const schema = INVOKE_CHANNELS["runtime:prepare-source-commit"].response;
    const request = {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    };
    const response = {
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/review-fix",
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, accessToken: "secret" }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, paths: ["../system/config.json"] }).success).toBe(false);
    expect(schema.safeParse(response).success).toBe(true);
    expect(schema.safeParse({ ...response, bearerToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({ ...response, branch: "/home/matrix/private" }).success).toBe(false);
  });

  it("validates runtime:create-source-pull-request requests and rejects credential leakage shapes", () => {
    const requestSchema = INVOKE_CHANNELS["runtime:create-source-pull-request"].request;
    const schema = INVOKE_CHANNELS["runtime:create-source-pull-request"].response;
    const request = {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    };
    const response = {
      status: "created",
      number: 808,
      url: "https://github.com/HamedMP/matrix-os/pull/808",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, accessToken: "secret" }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, title: "" }).success).toBe(false);
    expect(schema.safeParse(response).success).toBe(true);
    expect(schema.safeParse({ ...response, bearerToken: "secret" }).success).toBe(false);
    expect(schema.safeParse({ ...response, url: "file:///home/matrix/private/secret" }).success).toBe(false);
  });

  it("validates auth:poll responses and rejects token leakage shapes", () => {
    const schema = INVOKE_CHANNELS["auth:poll"].response;
    expect(schema.safeParse({ status: "authorized", profile: { handle: "neo", userId: "u1" } }).success).toBe(true);
    expect(schema.safeParse({ status: "pending" }).success).toBe(true);
    // Strict schemas refuse extra fields so a credential can never ride along.
    expect(
      schema.safeParse({ status: "authorized", profile: { handle: "n", userId: "u" }, accessToken: "tok" }).success,
    ).toBe(false);
  });

  it("bounds runtime:select slot", () => {
    const schema = INVOKE_CHANNELS["runtime:select"].request;
    expect(schema.safeParse({ slot: "primary" }).success).toBe(true);
    expect(schema.safeParse({ slot: "" }).success).toBe(false);
    expect(schema.safeParse({ slot: "x".repeat(65) }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("bounds notify payloads", () => {
    const schema = INVOKE_CHANNELS.notify.request;
    expect(
      schema.safeParse({ threadId: "t1", title: "Done", body: "ok", kind: "done" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ threadId: "t1", title: "x".repeat(81), body: "ok", kind: "done" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ threadId: "t1", title: "t", body: "y".repeat(201), kind: "done" }).success,
    ).toBe(false);
    expect(schema.safeParse({ threadId: "t1", title: "t", body: "b", kind: "weird" }).success).toBe(false);
  });

  it("bounds embed bounds rects", () => {
    const schema = INVOKE_CHANNELS["embed:set-bounds"].request;
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0, y: 38, width: 800, height: 600 } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0, y: 0, width: 99999, height: 1 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0.5, y: 0, width: 10, height: 10 } }).success,
    ).toBe(false);
  });

  it("requires embed:open to return the initial embed state", () => {
    const schema = INVOKE_CHANNELS["embed:open"].response;
    expect(schema.safeParse({ embedId: "e1", state: "loading" }).success).toBe(true);
    expect(schema.safeParse({ embedId: "e1" }).success).toBe(false);
    expect(schema.safeParse({ embedId: "e1", state: "auth-required", token: "secret" }).success).toBe(false);
  });

  it("caps state:set values at 64KB and only allows known keys", () => {
    const schema = INVOKE_CHANNELS["state:set"].request;
    expect(schema.safeParse({ key: "appearance", value: { theme: "dark" } }).success).toBe(true);
    expect(schema.safeParse({ key: "nope", value: 1 }).success).toBe(false);
    const big = { blob: "x".repeat(70_000) };
    expect(schema.safeParse({ key: "panelLayouts", value: big }).success).toBe(false);
  });

  it("only allows https urls on shell:open-external", () => {
    const schema = INVOKE_CHANNELS["shell:open-external"].request;
    expect(schema.safeParse({ url: "https://matrix-os.com" }).success).toBe(true);
    expect(schema.safeParse({ url: "http://matrix-os.com" }).success).toBe(false);
    expect(schema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(schema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("defines event channels with schemas", () => {
    for (const ch of [
      "auth:changed",
      "runtime:changed",
      "embed:state",
      "notification:clicked",
      "update:available",
      "update:ready",
      "window:focus-changed",
    ] as const) {
      expect(EVENT_CHANNELS[ch], ch).toBeDefined();
    }
    expect(
      EVENT_CHANNELS["embed:state"].safeParse({ embedId: "e", state: "auth-required" }).success,
    ).toBe(true);
    expect(EVENT_CHANNELS["embed:state"].safeParse({ embedId: "e", state: "??" }).success).toBe(false);
  });
});
