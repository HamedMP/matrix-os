import { describe, expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

describe("canonical Chat presentation adapter", () => {
  it("shows the canonical selected model first while a Run is active", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;

    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(presented?.work).toEqual([
      {
        kind: "activity-group",
        id: `${run.id}:selected-model`,
        timestamp: Date.parse(run.createdAt),
        sequence: 0,
        activities: [{
          id: `${run.id}:selected-model`,
          kind: "phase",
          state: "running",
          label: "Working",
          preview: "Current model: gpt-5.6-sol",
          previewKind: "text",
        }],
      },
    ]);
  });

  it("deduplicates a provider model status against the canonical selected model", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;

    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [{
        id: "activity_provider_model_status",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 1,
        type: "agent.activity",
        activityId: "provider_model_status",
        kind: "phase",
        label: "Working",
        summary: "Current model: gpt-5.6-sol",
        status: "running",
        occurredAt: run.createdAt,
      }],
    });

    expect(presented?.work).toEqual([
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:selected-model`,
      }),
    ]);
  });

  it("caps active transcript projection while preserving the newest server-ordered activity", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const occurredAt = run.startedAt ?? run.createdAt;
    const activities = Array.from({ length: 501 }, (_, index) => ({
      id: `activity_bounded_${index}`,
      chatId: snapshot.chat.id,
      runId: run.id,
      sequence: index + 1,
      type: "agent.activity" as const,
      activityId: `bounded_${index}`,
      kind: "phase" as const,
      label: `Phase ${index}`,
      status: "completed" as const,
      occurredAt,
    }));

    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities,
    });
    const projectedActivities = presented?.work.filter((item) => item.kind === "activity-group") ?? [];

    expect(projectedActivities).toHaveLength(500);
    expect(projectedActivities[0]?.id).toBe(`${run.id}:selected-model`);
    expect(projectedActivities.some((item) => item.id.endsWith("activity_bounded_1"))).toBe(false);
    expect(projectedActivities.at(-1)?.id).toContain("activity_bounded_500");
  });

  it("retains a newest server update when it reuses the oldest activity id", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const occurredAt = run.startedAt ?? run.createdAt;
    const activities = Array.from({ length: 500 }, (_, index) => ({
      id: `activity_reused_${index}`,
      chatId: snapshot.chat.id,
      runId: run.id,
      sequence: index + 1,
      type: "agent.activity" as const,
      activityId: `reused_${index}`,
      kind: "phase" as const,
      label: `Phase ${index}`,
      status: "running" as const,
      occurredAt,
    }));

    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [
        ...activities,
        { ...activities[0]!, sequence: 501, label: "Phase 0 updated" },
      ],
    });
    const projectedActivities = presented?.work.filter((item) => item.kind === "activity-group") ?? [];

    expect(projectedActivities).toHaveLength(500);
    expect(projectedActivities.some((item) => item.id.endsWith("activity_reused_1"))).toBe(false);
    expect(projectedActivities.at(-1)).toMatchObject({
      id: expect.stringContaining("activity_reused_0"),
      activities: [expect.objectContaining({ label: "Phase 0 updated" })],
    });
  });

  it("projects canonical messages into the shared provider-neutral transcript", () => {
    const { snapshot } = createCanonicalChatFixture("completed");

    const turns = canonicalChatPresentation({
      messages: [...snapshot.messages, {
        id: "msg_fixture_answer",
        chatId: snapshot.chat.id,
        seq: 2,
        role: "assistant",
        state: "committed",
        turnId: snapshot.turns[0]!.id,
        runId: snapshot.runs[0]!.id,
        parts: [{ type: "text", text: "The canonical Chat contract is ready." }],
        createdAt: snapshot.runs[0]!.updatedAt,
      }],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: snapshot.turns[0]?.id,
      active: false,
      user: { role: "user" },
      final: { role: "assistant" },
    });
  });

  it("projects live approval decisions into actionable transcript controls", () => {
    const { snapshot } = createCanonicalChatFixture("approval_required");

    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [...snapshot.activities, {
        id: "activity_approval",
        chatId: snapshot.chat.id,
        runId: snapshot.runs[0]!.id,
        occurredAt: snapshot.runs[0]!.updatedAt,
        type: "approval.requested",
        approvalId: "approval_fixture",
        title: "Run command",
        risk: "medium",
        allowedDecisions: ["approve", "decline"],
      }],
    });

    expect(presented?.work).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "request",
        requestKind: "approval",
        requestId: "approval_fixture",
        state: "waiting",
        actions: [
          { kind: "approval", requestId: "approval_fixture", decision: "approve", label: "Approve" },
          { kind: "approval", requestId: "approval_fixture", decision: "decline", label: "Decline" },
        ],
      }),
    ]));
  });

  it("reassembles adjacent durable text parts without changing assistant output", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, {
        id: "msg_fixture_chunked_answer",
        chatId: snapshot.chat.id,
        seq: 2,
        role: "assistant",
        state: "committed",
        turnId: snapshot.turns[0]!.id,
        runId: snapshot.runs[0]!.id,
        parts: [
          { type: "text", text: "boundary" },
          { type: "text", text: "-exact\n" },
          { type: "text", text: "continuation" },
        ],
        createdAt: snapshot.runs[0]!.updatedAt,
      }],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(presented?.final).toMatchObject({
      markdown: "boundary-exact\ncontinuation",
      copyText: "boundary-exact\ncontinuation",
    });
  });

  it("keeps message references, tools, requests, and status separate from assistant text", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const user = {
      ...snapshot.messages[0]!,
      parts: [
        { type: "text" as const, text: "Inspect these inputs" },
        { type: "attachment_reference" as const, attachmentId: "attachment_log", kind: "file" as const, label: "run.log" },
        { type: "resource_reference" as const, resource: { kind: "project" as const, id: "project_matrix", label: "Matrix OS" } },
        { type: "invocation_reference" as const, invocation: { kind: "skill" as const, descriptorId: "skill_review", invocation: "/review" } },
      ],
    };
    const assistant = {
      id: "msg_structured_answer",
      chatId: snapshot.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "committed" as const,
      turnId: snapshot.turns[0]!.id,
      runId: snapshot.runs[0]!.id,
      parts: [
        { type: "tool_request" as const, toolCallId: "tool_tests", name: "terminal", label: "Run tests", inputPreview: "Focused suite" },
        { type: "tool_result" as const, toolCallId: "tool_tests", outcome: "failed" as const, text: "One test failed.", truncated: false },
        {
          type: "approval_request" as const,
          approvalId: "approval_retry",
          title: "Retry the command",
          description: "Run the focused suite again.",
          risk: "low" as const,
          allowedDecisions: ["approve" as const, "decline" as const],
        },
        { type: "status" as const, tone: "warning" as const, label: "Partial result", detail: "Useful output was preserved." },
        { type: "summary" as const, text: "Finished summary", source: "assistant" as const },
      ],
      createdAt: snapshot.runs[0]!.updatedAt,
    };

    const [presented] = canonicalChatPresentation({
      messages: [user, assistant],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(presented?.user).toMatchObject({
      markdown: "Inspect these inputs",
      references: [
        { id: "attachment_log", kind: "file", label: "run.log" },
        { id: "project_matrix", kind: "resource", label: "Matrix OS" },
        { id: "skill_review", kind: "invocation", label: "/review" },
      ],
    });
    expect(presented?.work).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "activity-group",
        activities: [expect.objectContaining({ label: "Run tests", state: "failed", detail: "Focused suite\n\nOne test failed." })],
      }),
      expect.objectContaining({ kind: "request", requestKind: "approval", state: "waiting", label: "Retry the command" }),
      expect.objectContaining({ kind: "notice", tone: "warning", label: "Partial result" }),
    ]));
    expect(presented?.final).toMatchObject({ markdown: "Finished summary", copyText: "Finished summary" });
  });

  it("preserves inline user references and image previews in authored order", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const user = {
      ...snapshot.messages[0]!,
      parts: [
        { type: "text" as const, text: "/matrix-app-builder create a game in [apps](apps) using this screenshot" },
        {
          type: "invocation_reference" as const,
          invocation: { kind: "skill" as const, descriptorId: "matrix-app-builder", invocation: "/matrix-app-builder" },
        },
        {
          type: "resource_reference" as const,
          resource: { kind: "folder" as const, id: "apps", label: "apps" },
        },
        {
          type: "attachment_reference" as const,
          attachmentId: "attachment_screenshot",
          kind: "image" as const,
          label: "Screenshot.png",
          mimeType: "image/png",
          ownerReference: "temporary/desktop-chat/Screenshot.png",
        },
      ],
    };

    const [presented] = canonicalChatPresentation({
      messages: [user],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(presented?.user?.content).toEqual([
      { kind: "reference", id: "matrix-app-builder", referenceKind: "invocation", label: "/matrix-app-builder" },
      { kind: "text", text: " create a game in " },
      { kind: "reference", id: "apps", referenceKind: "resource", label: "apps" },
      { kind: "text", text: " using this screenshot" },
      {
        kind: "image",
        id: "attachment_screenshot",
        label: "Screenshot.png",
        src: "/api/files/blob?path=temporary%2Fdesktop-chat%2FScreenshot.png",
      },
    ]);
  });

  it("keeps process text and activities in one chronological Work timeline and only the last result outside", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const run = snapshot.runs[0]!;
    const assistant = (id: string, seq: number, text: string, createdAt: string) => ({
      id,
      chatId: snapshot.chat.id,
      seq,
      role: "assistant" as const,
      state: "committed" as const,
      turnId: snapshot.turns[0]!.id,
      runId: run.id,
      parts: [{ type: "text" as const, text }],
      createdAt,
    });
    const processOne = assistant("msg_process_one", 2, "I’ll inspect the project first.", "2026-08-26T00:00:01.000Z");
    const processTwo = assistant("msg_process_two", 3, "The failing command points to the build step.", "2026-08-26T00:00:03.000Z");
    const result = assistant("msg_result", 4, "The game is ready in ~/apps/flappy-bird.", "2026-08-26T00:00:05.000Z");

    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, processOne, processTwo, result],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [{
        id: "activity_command",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 1,
        type: "agent.activity",
        activityId: "command_build",
        kind: "command",
        label: "Run build",
        status: "completed",
        preview: "pnpm build",
        previewKind: "command",
        detail: "Completed in ~/apps/flappy-bird",
        occurredAt: "2026-08-26T00:00:02.000Z",
      }],
    });

    expect(presented?.work.map((item) => item.id)).toEqual([
      "msg_process_one",
      `${run.id}:activities:activity_command`,
      "msg_process_two",
    ]);
    expect(presented?.final).toMatchObject({
      id: "msg_result",
      markdown: "The game is ready in ~/apps/flappy-bird.",
    });
  });

  it("keeps live assistant process text inside Working until a terminal result exists", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [{
        id: "activity_delta",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 1,
        type: "assistant.delta",
        messageId: "msg_live_process",
        delta: "I’m checking the build output.",
        occurredAt: "2026-08-26T00:00:01.000Z",
      }],
    });

    expect(presented?.work).toContainEqual(expect.objectContaining({
      id: "msg_live_process",
      kind: "message",
      phase: "commentary",
      markdown: "I’m checking the build output.",
    }));
    expect(presented?.final).toBeUndefined();
  });

  it("shows the model first and removes generic Thinking when visible work arrives", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const reasoning = {
      id: "activity_thinking_placeholder",
      chatId: snapshot.chat.id,
      runId: run.id,
      sequence: 1,
      type: "agent.activity" as const,
      activityId: "reasoning_placeholder",
      kind: "reasoning" as const,
      label: "Thinking",
      status: "running" as const,
      occurredAt: "2026-08-26T00:00:01.000Z",
    };

    const [placeholderOnly] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [reasoning],
    });
    expect(placeholderOnly?.work).toEqual([
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:selected-model`,
        activities: [expect.objectContaining({ preview: "Current model: gpt-5.6-sol" })],
      }),
    ]);

    const [withVisibleProcessText] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [reasoning, {
        id: "activity_visible_process",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 2,
        type: "assistant.delta",
        messageId: "msg_visible_process",
        delta: "I’ll inspect the project first.",
        occurredAt: "2026-08-26T00:00:02.000Z",
      }],
    });
    expect(withVisibleProcessText?.work).toEqual([
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:selected-model`,
      }),
      expect.objectContaining({
        kind: "message",
        id: "msg_visible_process",
        markdown: "I’ll inspect the project first.",
      }),
    ]);

    const [withRealActivity] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [reasoning, {
        id: "activity_command_after_thinking",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 2,
        type: "agent.activity",
        activityId: "command_after_thinking",
        kind: "command",
        label: "Run command",
        preview: "pnpm build",
        previewKind: "command",
        status: "running",
        occurredAt: "2026-08-26T00:00:02.000Z",
      }, {
        ...reasoning,
        id: "activity_late_thinking_placeholder",
        activityId: "late_reasoning_placeholder",
        sequence: 3,
        occurredAt: "2026-08-26T00:00:03.000Z",
      }],
    });
    expect(withRealActivity?.work).toEqual([
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:selected-model`,
      }),
      expect.objectContaining({
        kind: "activity-group",
        activities: [expect.objectContaining({ kind: "command", label: "Run command" })],
      }),
    ]);
  });

  it("omits generic Thinking rows from completed Worked history", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const run = snapshot.runs[0]!;
    const process = {
      id: "msg_completed_process",
      chatId: snapshot.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "committed" as const,
      turnId: snapshot.turns[0]!.id,
      runId: run.id,
      parts: [{ type: "text" as const, text: "I inspected the project." }],
      createdAt: "2026-08-26T00:00:02.000Z",
    };
    const result = {
      ...process,
      id: "msg_completed_result",
      seq: 3,
      parts: [{ type: "text" as const, text: "The project is ready." }],
      createdAt: "2026-08-26T00:00:04.000Z",
    };
    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, process, result],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [{
        id: "activity_completed_thinking",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 1,
        type: "agent.activity",
        activityId: "reasoning_completed_placeholder",
        kind: "reasoning",
        label: "Thinking",
        status: "completed",
        occurredAt: "2026-08-26T00:00:01.000Z",
      }],
    });

    expect(presented?.work).toEqual([
      expect.objectContaining({ id: "msg_completed_process", markdown: "I inspected the project." }),
    ]);
    expect(presented?.final).toMatchObject({ id: "msg_completed_result", markdown: "The project is ready." });
  });

  it("projects typed activity in durable server sequence with partial state intact", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const [presented] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [
        {
          id: "activity_phase",
          chatId: snapshot.chat.id,
          runId: run.id,
          sequence: 4,
          type: "agent.activity",
          activityId: "phase_execute",
          kind: "phase",
          label: "Executing",
          status: "completed",
          occurredAt: "2026-08-26T00:00:00.000Z",
        },
        {
          id: "activity_reasoning",
          chatId: snapshot.chat.id,
          runId: run.id,
          sequence: 3,
          type: "agent.activity",
          activityId: "reasoning_summary",
          kind: "reasoning",
          label: "Analyzed the failure",
          status: "partial",
          summary: "The command failed after producing useful output.",
          occurredAt: "2026-08-26T00:01:00.000Z",
        },
      ],
    });

    expect(presented?.work).toEqual([
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:selected-model`,
        activities: [expect.objectContaining({ preview: "Current model: gpt-5.6-sol" })],
      }),
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:activities:activity_reasoning`,
        activities: [expect.objectContaining({ id: "activity_reasoning", kind: "reasoning", state: "partial" })],
      }),
      expect.objectContaining({
        kind: "activity-group",
        id: `${run.id}:activities:activity_phase`,
        activities: [expect.objectContaining({ id: "activity_phase", kind: "phase", state: "completed" })],
      }),
    ]);
  });

  it("projects persisted run activity and assistant deltas while a Run is active", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const turn = snapshot.turns[0]!;
    const occurredAt = run.startedAt ?? run.createdAt;

    const turns = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [
        {
          id: "activity_tool_running",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "tool.progress",
          toolCallId: "tool_fixture",
          label: "Reading project files",
          status: "running",
          occurredAt,
        },
        {
          id: "activity_delta_one",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "assistant.delta",
          messageId: "msg_fixture_stream",
          delta: "I found ",
          occurredAt,
        },
        {
          id: "activity_delta_two",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "assistant.delta",
          messageId: "msg_fixture_stream",
          delta: "the issue.",
          occurredAt,
        },
      ],
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: turn.id,
      active: true,
      work: [
        expect.objectContaining({
          kind: "activity-group",
          id: `${run.id}:selected-model`,
          activities: [expect.objectContaining({ preview: "Current model: gpt-5.6-sol" })],
        }),
        expect.objectContaining({
          kind: "activity-group",
          activities: [expect.objectContaining({ label: "Reading project files", state: "running" })],
        }),
        expect.objectContaining({
          kind: "message",
          phase: "commentary",
          role: "assistant",
          markdown: "I found the issue.",
          copyText: "I found the issue.",
        }),
      ],
    });
    expect(turns[0]?.final).toBeUndefined();
  });

  it("keeps failed partial text as commentary and exposes the authoritative failure", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const turn = snapshot.turns[0]!;
    const completedAt = "2026-08-26T00:01:00.000Z";
    const failedRun = {
      ...run,
      status: "failed" as const,
      outcome: "failed" as const,
      completedAt,
      updatedAt: completedAt,
    };
    const partial = {
      id: "msg_failed_partial",
      chatId: snapshot.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "failed" as const,
      turnId: turn.id,
      runId: run.id,
      parts: [{ type: "text" as const, text: "I changed the first half" }],
      createdAt: completedAt,
    };

    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, partial],
      turns: snapshot.turns,
      runs: [failedRun],
      activities: [{
        id: "activity_failed",
        chatId: snapshot.chat.id,
        runId: run.id,
        sequence: 1,
        type: "run.error",
        error: { code: "run_failed", safeMessage: "The agent run failed.", retryable: true },
        occurredAt: completedAt,
      }],
    });

    expect(presented?.work).toContainEqual(expect.objectContaining({
      id: partial.id,
      kind: "message",
      phase: "commentary",
      markdown: "I changed the first half",
    }));
    expect(presented?.final).toMatchObject({
      kind: "notice",
      tone: "failed",
      label: "Agent work failed",
      markdown: "The agent run failed.",
    });
  });

  it("drops assistant text from a failed attempt once its retry becomes authoritative", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const firstRun = snapshot.runs[0]!;
    const turn = snapshot.turns[0]!;
    const failedAt = "2026-08-26T00:01:00.000Z";
    const retryAt = "2026-08-26T00:01:01.000Z";
    const stalePartial = {
      id: "msg_failed_attempt_partial",
      chatId: snapshot.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "failed" as const,
      turnId: turn.id,
      runId: firstRun.id,
      parts: [{ type: "text" as const, text: "I’ll look for flappy bird code in the repo." }],
      createdAt: failedAt,
    };
    const retryRun = {
      ...firstRun,
      id: "run_retry_attempt_2",
      attempt: 2,
      status: "accepted" as const,
      outcome: undefined,
      createdAt: retryAt,
      updatedAt: retryAt,
      startedAt: undefined,
      completedAt: undefined,
    };

    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, stalePartial],
      turns: snapshot.turns,
      runs: [{
        ...firstRun,
        status: "failed",
        outcome: "failed",
        completedAt: failedAt,
        updatedAt: failedAt,
      }, retryRun],
      activities: [],
    });

    expect(presented?.active).toBe(true);
    expect(JSON.stringify(presented?.work)).not.toContain("I’ll look for flappy bird code in the repo.");
  });

  it("keeps aborted partial text and exposes a stopped terminal notice", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const turn = snapshot.turns[0]!;
    const completedAt = "2026-08-26T00:01:00.000Z";
    const partial = {
      id: "msg_aborted_partial",
      chatId: snapshot.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "failed" as const,
      turnId: turn.id,
      runId: run.id,
      parts: [{ type: "text" as const, text: "Partial work before cancellation" }],
      createdAt: completedAt,
    };

    const [presented] = canonicalChatPresentation({
      messages: [...snapshot.messages, partial],
      turns: snapshot.turns,
      runs: [{
        ...run,
        status: "aborted",
        outcome: "aborted",
        completedAt,
        updatedAt: completedAt,
      }],
      activities: [],
    });

    expect(presented?.work).toContainEqual(expect.objectContaining({
      id: partial.id,
      phase: "commentary",
      markdown: "Partial work before cancellation",
    }));
    expect(presented?.final).toMatchObject({
      kind: "notice",
      tone: "stopped",
      label: "Agent work stopped",
      markdown: "Run was cancelled.",
    });
  });
});
