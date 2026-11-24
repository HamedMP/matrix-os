// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSetupStartRequestSchema, ProjectSetupUpdateRequestSchema, type CanonicalChatDetailResponse, type CanonicalChatMessage } from "@matrix-os/contracts";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { projectSetupDetailPresentation } from "../../packages/ui/src/chat/project-setup-presentation";
import { useProjectSetup, type ProjectSetupTransport } from "../../packages/ui/src/chat/use-project-setup";

const webSetup = vi.hoisted(() => ({ active: false }));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat/useWebProjectSetup", () => ({
  useWebProjectSetup: () => ({ active: webSetup.active, canAnswer: true }),
}));

afterEach(cleanup);
const draft = {
  chatId: "chat_setup",
  projectId: "project_a",
  revision: 1,
  step: "guidance",
  currentQuestionMessageId: "msg_guidance",
  answers: { purpose: "Portfolio website" },
  proposals: [],
  mcp: { state: "not_requested" },
  updatedAt: "2026-11-22T12:00:00.000Z",
};
function transport() {
  return {
    get: vi.fn<ProjectSetupTransport["get"]>(async () => ({ draft: null })),
    post: vi.fn<ProjectSetupTransport["post"]>(async () => ({ draft })),
    patch: vi.fn<ProjectSetupTransport["patch"]>(async () => ({ draft: { ...draft, revision: 2, step: "skill" } })),
  } satisfies ProjectSetupTransport;
}

const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }] };
const interviewDraft = {
  ...draft,
  interview: { focus: "intent", suggestions: [] },
  generation: { status: "unavailable" },
};

it("does not create a Chat or run on project overview or Skip", async () => {
  const client = transport();
  const { result } = renderHook(() =>
    useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true }),
  );
  await act(async () => {});
  expect(result.current.active).toBe(false);
  act(() => result.current.dismiss());
  expect(client.get).not.toHaveBeenCalled();
  expect(client.post).not.toHaveBeenCalled();
  expect(client.patch).not.toHaveBeenCalled();
});

it("launches the Agent on explicit start with the canonical composer's model", async () => {
  const client = transport();
  client.post.mockResolvedValue({ draft: interviewDraft });
  const open = vi.fn();
  const { result } = renderHook(() => useProjectSetup({
    client, scope: "owner:computer", projectId: "project_a", eligible: true, onOpenChat: open,
    selection: { ...selection, permissionMode: "supervised" } as typeof selection,
  }));
  await act(async () => result.current.start());
  expect(client.post).toHaveBeenCalledOnce();
  expect(client.post.mock.calls[0]?.[0]).toBe("/api/projects/project_a/setup");
  const body = ProjectSetupStartRequestSchema.parse(client.post.mock.calls[0]?.[1]);
  expect(body).toMatchObject({ mode: "interview", currentSelection: selection });
  expect(open).toHaveBeenCalledWith("chat_setup");
});

it("delegates the explicit resumption to the scoped, idempotent project start", async () => {
  const client = transport();
  client.post.mockResolvedValue({ draft: interviewDraft });
  const open = vi.fn();
  const { result } = renderHook(() =>
    useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true, onOpenChat: open }),
  );
  await act(async () => result.current.start());
  expect(open).toHaveBeenCalledWith("chat_setup");
  expect(client.post).toHaveBeenCalledOnce();
  expect(client.get).not.toHaveBeenCalled();
});

it("aborts generation launch and ignores its response after a project switch", async () => {
  let resolve!: (value: unknown) => void;
  const client = transport();
  client.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  const open = vi.fn();
  const { result, rerender } = renderHook(
    ({ projectId }) =>
      useProjectSetup({ client, scope: "owner:computer", projectId, eligible: true, onOpenChat: open }),
    { initialProps: { projectId: "project_a" } },
  );
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.start(); });
  const signal = client.post.mock.calls[0]?.[2];
  rerender({ projectId: "project_b" });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve({ draft: interviewDraft });
    expect(await pending).toBe(false);
  });
  expect(open).not.toHaveBeenCalled();
  expect(result.current.draft).toBeNull();
  expect(result.current.active).toBe(false);
});

it("keeps the start request identity across an uncertain network retry", async () => {
  const client = transport();
  client.post.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() =>
    useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true }),
  );
  await act(async () => result.current.start());
  expect(result.current.error).toBeTruthy();
  await act(async () => result.current.start());
  expect(client.post.mock.calls[0]?.[1]).toEqual(client.post.mock.calls[1]?.[1]);
});

it("sends a whole answer to the Agent from review and can retry without echoing it again", async () => {
  const client = transport();
  const ready = { ...interviewDraft, step: "review", interview: { focus: "review", suggestions: [] }, generation: { status: "completed" } };
  client.get.mockResolvedValue({ draft: ready });
  client.patch.mockResolvedValueOnce({ draft: { ...ready, revision: 2, generation: { status: "unavailable" } } });
  client.patch.mockResolvedValueOnce({ draft: { ...ready, revision: 3, generation: { status: "running", runId: "run_setup" } } });
  const { result } = renderHook(() => useProjectSetup({
    client, scope: "owner:computer", projectId: "project_a", chatId: "chat_setup", eligible: true, selection,
  }));
  await act(async () => {});
  const text = "Draft release notes from Linear and ask before publishing.";
  await act(async () => expect(await result.current.answer(text)).toBe(true));
  expect(ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[0]?.[1]).action).toEqual({
    type: "interview_answer", text, selection,
  });
  expect(result.current.canAnswer).toBe(false);
  await act(async () => expect(await result.current.retryInterview()).toBe(true));
  expect(ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[1]?.[1]).action).toEqual({
    type: "interview_retry", selection,
  });
});

it("keeps an explicit MCP skip in the scoped interview flow with the selected model", async () => {
  const client = transport();
  client.get.mockResolvedValue({ draft: {
    ...interviewDraft, interview: { focus: "mcp", suggestions: [], mcpHandoff: true },
    mcp: { state: "pending", service: "Linear" }, generation: { status: "completed" },
  } });
  const { result } = renderHook(() => useProjectSetup({
    client, scope: "owner:computer", projectId: "project_a", chatId: "chat_setup", eligible: true, selection,
  }));
  await act(async () => {});
  await act(async () => expect(await result.current.dispatch({ type: "choose_mcp", choice: "skip" })).toBe(true));
  expect(ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[0]?.[1]).action).toEqual({
    type: "choose_mcp", choice: "skip", selection,
  });
});

it("polls an admitted initial setup within its scoped Chat and stops after navigation", async () => {
  vi.useFakeTimers();
  try {
    const client = transport();
    const pending = { ...interviewDraft, generation: { status: "pending" } };
    client.get.mockResolvedValue({ draft: pending });
    client.patch.mockResolvedValue({ draft: pending });
    const { rerender } = renderHook(({ projectId, chatId }: { projectId: string; chatId?: string }) =>
      useProjectSetup({ client, scope: "owner:computer", projectId, chatId, eligible: true }),
      { initialProps: { projectId: "project_a", chatId: "chat_setup" } },
    );
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(client.patch).toHaveBeenCalledExactlyOnceWith("/api/chats/chat_setup/project-setup",
      expect.objectContaining({ action: { type: "sync_generation" } }), expect.anything());
    rerender({ projectId: "project_b", chatId: undefined });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(client.patch).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("leaves an ordinary existing Chat outside setup when it has no setup draft", async () => {
  const client = transport();
  const { result } = renderHook(() =>
    useProjectSetup({
      client,
      scope: "owner:computer",
      projectId: "project_a",
      chatId: "chat_ordinary",
      eligible: true,
    }),
  );
  await act(async () => {});
  expect(result.current.active).toBe(false);
  expect(result.current.introduction).toBe(false);
  await act(async () => {
    expect(await result.current.answer("A normal message")).toBe(false);
  });
  expect(client.post).not.toHaveBeenCalled();
  expect(client.patch).not.toHaveBeenCalled();
});


it("encodes generation through the strict PATCH schema and preserves its canonical retry identity", async () => {
  const client = transport();
  client.get.mockResolvedValue({ draft: { ...draft, step: "review" } });
  client.patch.mockRejectedValueOnce(new Error("uncertain response"));
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }], interactionMode: "review", permissionMode: "supervised" };
  const { result } = renderHook(() => useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", chatId: "chat_setup", eligible: true }));
  await act(async () => {});
  await act(async () => result.current.dispatch({ type: "generate", selection }));
  const retrySelection = { ...selection, permissionMode: "full_access" };
  await act(async () => result.current.dispatch({ type: "generate", selection: retrySelection }));
  const first = ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[0]?.[1]);
  const retry = ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[1]?.[1]);
  expect(first).toEqual(retry);
  expect(first.action).toEqual({ type: "generate", selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }] } });
});

it("waits for an explicit review action before treating typed text as guidance revisions", async () => {
  const client = transport();
  const pending = { ...draft, step: "review", mcp: { state: "pending", service: "Linear" } };
  client.get.mockResolvedValue({ draft: pending });
  client.patch.mockResolvedValue({ draft: { ...pending, currentQuestionMessageId: "msg_review" } });
  const { result } = renderHook(() => useProjectSetup({
    client, scope: "owner:computer", projectId: "project_a", chatId: "chat_setup", eligible: true,
  }));
  await act(async () => {});
  await act(async () => {
    expect(await result.current.answer("An unrelated message")).toBe(false);
  });
  expect(client.patch).not.toHaveBeenCalled();
  await act(async () => result.current.continueToReview());
  expect(ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[0]?.[1]).action).toEqual({ type: "prepare_review" });
  await act(async () => result.current.answer("Run tests"));
  expect(ProjectSetupUpdateRequestSchema.parse(client.patch.mock.calls[1]?.[1]).action).toEqual({
    type: "revise", field: "guidance", text: "Run tests",
  });
});

it("preserves approved interview questions in both transcripts without showing raw provider messages", () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const run = { ...snapshot.runs[0]!, context: {
    version: 1 as const, requestHash: "a".repeat(64), chats: [],
    projectSetupDraft: { revision: 3, mode: "interview" as const },
  } };
  const internalInput = snapshot.messages[0]!;
  const internalOutput: CanonicalChatMessage = {
    ...internalInput, id: "msg_generated", role: "assistant", purpose: "assistant",
    runId: run.id, parts: [{ type: "text", text: '{"reply":"private structured draft"}' }],
  };
  const detail: CanonicalChatDetailResponse = {
    record: { chat: snapshot.chat, projectId: "matrix-os" }, runs: [run],
    messages: [], turns: snapshot.turns, activities: [],
  };
  const ordinaryTurn = { ...detail.turns[0]!, id: "cturn_setup_discussion", inputMessageId: "msg_owner", baseMessageSeq: 0 };
  const owner = { ...internalInput, id: ordinaryTurn.inputMessageId, turnId: ordinaryTurn.id, seq: 1 };
  const question = {
    ...internalOutput, id: "msg_approved_question", runId: undefined, turnId: ordinaryTurn.id, seq: 4,
    parts: [{ type: "text" as const, text: "Should I ask before publishing release notes?" }],
  };
  detail.turns = [...detail.turns, ordinaryTurn];
  detail.messages = [
    owner,
    { ...internalInput, seq: 2 },
    { ...internalOutput, seq: 3 },
    question,
  ];

  const presented = projectSetupDetailPresentation(detail, null);
  expect(presented.messages.map(message => message.id)).toEqual([owner.id, question.id]);
  expect(canonicalChatPresentation(presented).some(turn => turn.final?.id === question.id)).toBe(true);
  expect(projectCanonicalTranscript(detail).map(message => message.id)).toEqual([owner.id, question.id]);
});

it("shows ordinary Web Chat suggestions only outside active project setup", async () => {
  const { ChatApp } = await import("../../shell/src/components/ChatApp");
  const props = {
    messages: [
      { id: "msg_input", role: "user" as const, content: "Set up this project with Chat.", timestamp: 1000 },
      { id: "msg_question", role: "assistant" as const, content: "Who should see the archive?", timestamp: 1001 },
    ],
    sessionId: "chat_setup", busy: false, connected: true, conversations: [],
    onSubmit: vi.fn(), onNewChat: vi.fn(), onSwitchConversation: vi.fn(),
  };
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  try {
    const { rerender } = render(<ChatApp {...props} />);
    expect(screen.getByRole("group", { name: "Suggested messages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "What can you do?" })).toBeTruthy();
    webSetup.active = true;
    rerender(<ChatApp {...props} />);
    expect(screen.queryByRole("group", { name: "Suggested messages" })).toBeNull();
    expect(screen.getByText("Who should see the archive?")).toBeTruthy();
  } finally {
    webSetup.active = false;
    cleanup();
    vi.unstubAllGlobals();
  }
});
