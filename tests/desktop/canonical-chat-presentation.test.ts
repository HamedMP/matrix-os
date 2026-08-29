import { describe, expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

describe("canonical Chat presentation adapter", () => {
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
