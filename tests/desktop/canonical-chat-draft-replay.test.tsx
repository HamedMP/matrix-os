// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatAgentDraftRequest } from "@matrix-os/ui";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import WorkTab from "@desktop/renderer/src/features/work/WorkTab";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { WorkSurfaceRuntimeProvider, useWorkSurfaceRuntime } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

it("defers a hidden draft seed, consumes it once when active and accepts a newer intent", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const onDraftConsumed = vi.fn();
  const props = { client, catalog: providerCatalog, projectId: null, initialView: "draft" as const, onDraftConsumed };
  const request = { id: 11, text: "First template" };
  const view = render(<CanonicalChatWorkspace {...props} active={false} draftRequest={request} />);
  expect(onDraftConsumed).not.toHaveBeenCalled();
  view.rerender(<CanonicalChatWorkspace {...props} active draftRequest={request} />);
  const composer = await screen.findByRole("textbox", { name: "Start a chat" });
  await waitFor(() => expect(composer.textContent).toBe("First template"));
  expect(onDraftConsumed).toHaveBeenCalledExactlyOnceWith(11);
  await setSharedComposerText(composer, "My edits");
  view.rerender(<CanonicalChatWorkspace {...props} active draftRequest={{ ...request }} />);
  expect(composer.textContent).toBe("My edits");
  expect(onDraftConsumed).toHaveBeenCalledTimes(1);
  view.rerender(<CanonicalChatWorkspace {...props} active draftRequest={{ id: 12, text: "Next template" }} />);
  await waitFor(() => expect(composer.textContent).toBe("Next template"));
  expect(onDraftConsumed).toHaveBeenLastCalledWith(12);
  expect(onDraftConsumed).toHaveBeenCalledTimes(2);
  expect(client.create).not.toHaveBeenCalled();
});

function pendingClient() {
  const client = createCanonicalChatWorkspaceClient();
  client.submitInput = vi.fn(async () => ({ requestId: "input_q", submission: "accepted" as const }));
  const run = { ...snapshot.runs.at(-1)!, status: "waiting_for_input" as const };
  vi.mocked(client.getDetail).mockResolvedValue({ record: { ...canonicalChatRecord,
    activeRun: { runId: run.id, turnId: run.turnId, status: run.status } },
    messages: snapshot.messages, turns: snapshot.turns, runs: [run], activities: [{
      id: "evt_input", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt,
      type: "input.requested", requestId: "input_q", title: "Test label",
      questions: [{ questionId: "q1", header: "Label", question: "Which test label?",
        allowOther: true, secret: false, options: [{ label: "Alpha", description: "Use Alpha" }, { label: "Beta", description: "Use Beta" }] }],
    }] });
  return client;
}

it("keeps a pending conversation after Project navigation, move and remove-context remounts with an old New chat request", async () => {
  const client = pendingClient();
  const request: ChatAgentDraftRequest = { id: 1, text: "" };
  function RouteHarness() {
    const [route, setRoute] = useState<"draft" | "chat" | "project">("draft");
    const [projectId, setProjectId] = useState<string | null>(null);
    return <>
      <button onClick={() => setRoute("chat")}>Open pending chat</button>
      <button onClick={() => setRoute("project")}>Open Project</button>
      <button onClick={() => setProjectId("matrix-os")}>Move to project</button>
      <button onClick={() => setProjectId(null)}>Remove project context</button>
      {route !== "project" && <CanonicalChatWorkspace key={`${route}:${projectId}`} client={client} catalog={providerCatalog}
        active projectId={projectId} initialView={route === "chat" ? "conversation" : "draft"}
        initialChatId={route === "chat" ? canonicalChatRecord.chat.id : undefined}
        draftRequest={request} externalNavigation />}
    </>;
  }
  render(<RouteHarness />);
  await screen.findByRole("textbox", { name: "Start a chat" });
  fireEvent.click(screen.getByRole("button", { name: "Open pending chat" }));
  expect(await screen.findByRole("radio", { name: /Alpha/ })).toBeTruthy();
  const userText = snapshot.messages.find(message => message.role === "user")!.parts
    .flatMap(part => part.type === "text" ? [part.text] : []).join("");
  expect(screen.getByRole("log").textContent).toContain(userText);
  fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open pending chat" }));
  expect(await screen.findByRole("radio", { name: /Alpha/ })).toBeTruthy();
  expect(screen.getByRole("log").textContent).toContain(userText);
  for (const action of ["Move to project", "Remove project context"]) {
    fireEvent.click(screen.getByRole("button", { name: action, exact: true }));
    expect(await screen.findByRole("radio", { name: /Alpha/ })).toBeTruthy();
    expect(screen.getByRole("log").textContent).toContain(userText);
    expect(screen.getByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
  }
  expect(screen.queryByRole("textbox", { name: "Start a chat" })).toBeNull();
  expect(client.create).not.toHaveBeenCalled();
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.submitInput).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /Alpha/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(client.submitInput).toHaveBeenCalledWith(canonicalChatRecord.chat.id,
    snapshot.runs.at(-1)!.id, "input_q", expect.objectContaining({ structuredAnswers: { q1: ["Alpha"] } })));
});

it("acknowledges a hosted template seed once instead of replaying it when the draft remounts", async () => {
  const post = vi.fn();
  useConnection.setState({ api: { baseUrl: "https://matrix.test", post,
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) throw new Error("Unavailable fixture catalog");
      return { items: [] };
    }),
  } as unknown as ApiClient });
  function HostedRoute() {
    const runtime = useWorkSurfaceRuntime();
    const [visible, setVisible] = useState(true);
    return <>
      <button onClick={() => runtime?.requestAgentDraft("Template seed")}>New template draft</button>
      <button onClick={() => setVisible(value => !value)}>Toggle Project</button>
      <output data-testid="request">{JSON.stringify(runtime?.agentDraftRequest)}</output>
      {visible && <WorkTab route="chat" initialChatView="draft" active />}
    </>;
  }
  render(<WorkSurfaceRuntimeProvider active={false}><HostedRoute /></WorkSurfaceRuntimeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "New template draft" }));
  const composer = await screen.findByRole("textbox", { name: "Start a chat" });
  await waitFor(() => expect(composer.textContent).toBe("Template seed"));
  expect(screen.getByTestId("request").textContent).toBe("null");
  await setSharedComposerText(composer, "Template seed with my edits");
  fireEvent.click(screen.getByRole("button", { name: "Toggle Project" }));
  fireEvent.click(screen.getByRole("button", { name: "Toggle Project" }));
  await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""));
  expect(screen.getByTestId("request").textContent).toBe("null");
  expect(post).not.toHaveBeenCalled();
});

it("ignores acknowledgements for a replaced request or a different authenticated runtime", () => {
  const originalIdentity = useConnection.getState();
  const { result } = renderHook(() => useWorkSurfaceRuntime()!, {
    wrapper: ({ children }) => <WorkSurfaceRuntimeProvider active={false}>{children}</WorkSurfaceRuntimeProvider>,
  });
  act(() => result.current.requestAgentDraft("First"));
  const first = result.current.agentDraftRequest!;
  const consumeFirstScope = result.current.consumeAgentDraft;
  const requestFirstScope = result.current.requestAgentDraft;
  act(() => result.current.requestAgentDraft("Second"));
  act(() => consumeFirstScope(first.id));
  expect(result.current.agentDraftRequest?.text).toBe("Second");
  const secondId = result.current.agentDraftRequest!.id;
  act(() => useConnection.setState({ authGeneration: 1, runtimeSlot: "pr-other" }));
  expect(result.current.agentDraftRequest).toBeNull();
  act(() => result.current.requestAgentDraft("Other runtime"));
  act(() => consumeFirstScope(secondId));
  expect(result.current.agentDraftRequest?.text).toBe("Other runtime");
  act(() => requestFirstScope("Stale runtime seed"));
  expect(result.current.agentDraftRequest?.text).toBe("Other runtime");
  act(() => result.current.consumeAgentDraft(result.current.agentDraftRequest!.id));
  expect(result.current.agentDraftRequest).toBeNull();
  act(() => useConnection.setState({ authGeneration: originalIdentity.authGeneration, runtimeSlot: originalIdentity.runtimeSlot }));
  expect(result.current.agentDraftRequest).toBeNull();
  act(() => result.current.requestAgentDraft("Returned runtime"));
  act(() => requestFirstScope("Old returned callback"));
  act(() => consumeFirstScope(first.id));
  expect(result.current.agentDraftRequest?.text).toBe("Returned runtime");
});
