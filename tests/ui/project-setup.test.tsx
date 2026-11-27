// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSetupStartRequestSchema, ProjectSetupUpdateRequestSchema } from "@matrix-os/contracts";
import { useProjectSetup, type ProjectSetupTransport } from "../../packages/ui/src/chat/use-project-setup";

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

it("opens the first question and skips without creating a Chat or file", async () => {
  const client = transport();
  const { result } = renderHook(() =>
    useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true }),
  );
  await act(async () => result.current.start());
  expect(result.current.introduction).toBe(true);
  expect(client.post).not.toHaveBeenCalled();
  act(() => result.current.dismiss());
  expect(result.current.introduction).toBe(false);
  expect(client.post).not.toHaveBeenCalled();
  expect(client.patch).not.toHaveBeenCalled();
});

it("creates the setup Chat only on its first explicit answer", async () => {
  const client = transport();
  const open = vi.fn();
  const { result } = renderHook(() =>
    useProjectSetup({
      client,
      scope: "owner:computer",
      projectId: "project_a",
      eligible: true,
      onOpenChat: open,
    }),
  );
  await act(async () => result.current.start());
  await act(async () => result.current.answer("Portfolio website"));
  expect(client.post).toHaveBeenCalledOnce();
  expect(client.post.mock.calls[0]?.[0]).toBe("/api/projects/project_a/setup");
  expect(open).toHaveBeenCalledWith("chat_setup");
  expect(result.current.draft?.answers.purpose).toBe("Portfolio website");
});

it("reuses an unfinished setup instead of creating another Chat", async () => {
  const client = transport();
  client.get.mockResolvedValue({ draft } as never);
  const open = vi.fn();
  const { result } = renderHook(() =>
    useProjectSetup({
      client,
      scope: "owner:computer",
      projectId: "project_a",
      eligible: true,
      onOpenChat: open,
    }),
  );
  await act(async () => result.current.start());
  expect(open).toHaveBeenCalledWith("chat_setup");
  expect(client.post).not.toHaveBeenCalled();
});

it("aborts requests and ignores old answers after a project switch", async () => {
  let resolve!: (value: unknown) => void;
  const client = transport();
  client.post.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never,
  );
  const open = vi.fn();
  const { result, rerender } = renderHook(
    ({ projectId }) =>
      useProjectSetup({ client, scope: "owner:computer", projectId, eligible: true, onOpenChat: open }),
    { initialProps: { projectId: "project_a" } },
  );
  await act(async () => result.current.start());
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.answer("Portfolio website");
  });
  rerender({ projectId: "project_b" });
  await act(async () => {
    resolve({ draft });
    await pending;
  });
  expect(open).not.toHaveBeenCalled();
  expect(result.current.draft).toBeNull();
  expect(result.current.introduction).toBe(false);
});

it("keeps the first-answer request identity across an uncertain network retry", async () => {
  const client = transport();
  client.post.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() =>
    useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true }),
  );
  await act(async () => result.current.start());
  await act(async () => result.current.answer("Portfolio website"));
  expect(result.current.error).toBeTruthy();
  await act(async () => result.current.answer("Portfolio website"));
  expect(client.post.mock.calls[0]?.[1]).toEqual(client.post.mock.calls[1]?.[1]);
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


it("encodes the native composer's extended selection as a strict canonical start request", async () => {
  const client = transport();
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }], interactionMode: "default", permissionMode: "supervised" };
  const open = vi.fn();
  const { result } = renderHook(() => useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true, selection, onOpenChat: open }));
  await act(async () => result.current.start());
  await act(async () => result.current.answer("Portfolio website"));
  const body = ProjectSetupStartRequestSchema.parse(client.post.mock.calls[0]?.[1]);
  expect(body.currentSelection).toEqual({ instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }] });
  expect(body.clientRequestId).toMatch(/^req_setup_/);
  expect(open).toHaveBeenCalledWith("chat_setup");
});

it("encodes generation through the strict PATCH schema and preserves its canonical retry identity", async () => {
  const client = transport();
  client.get.mockResolvedValue({ draft: { ...draft, step: "review" } });
  client.patch.mockRejectedValueOnce(new Error("uncertain response"));
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }], interactionMode: "review", permissionMode: "supervised" };
  const { result } = renderHook(() => useProjectSetup({ client, scope: "owner:computer", projectId: "project_a", eligible: true }));
  await act(async () => result.current.start());
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
