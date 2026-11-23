// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalChatSafeError } from "@matrix-os/contracts";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { OPEN_PROVIDER_SETTINGS_EVENT } from "../../shell/src/lib/canonical-provider-setup";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

// Owner outcome (ENG-554): Web Desktop and Web Canvas (both render ChatApp) show
// the same failure title, styling and recovery buttons as Electron Desktop.
// Fault caught: Web rendering a failed run as a plain chip with no action.
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function failedDetail(error: CanonicalChatSafeError): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("failed");
  const { project, activeRun, providerBinding, ...chat } = snapshot.chat;
  return {
    record: { chat, projectId: project?.projectId, activeRun, providerBinding }, messages: snapshot.messages,
    turns: snapshot.turns, runs: snapshot.runs, activities: [{ id: "act_failure", chatId: snapshot.chat.id,
      runId: snapshot.runs[0]!.id, sequence: 1, occurredAt: snapshot.chat.updatedAt, type: "run.error", error }],
  };
}

function renderFailure(error: CanonicalChatSafeError, props: Partial<React.ComponentProps<typeof ChatApp>> = {}) {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const detail = failedDetail(error);
  const onNewChat = vi.fn();
  render(<ChatApp messages={projectCanonicalTranscript(detail)} busy={false} connected sessionId={detail.record.chat.id}
    conversations={[]} onSubmit={vi.fn()} onNewChat={onNewChat} onSwitchConversation={vi.fn()} {...props} />);
  return { detail, onNewChat };
}

const legacySignIn: CanonicalChatSafeError = { code: "authorization_failed", retryable: true, recoveryActions: ["retry"],
  safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude." };

describe("Web Chat failure recovery", () => {
  it("names the harness and opens Agents & providers for a legacy sign-in failure", () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, opened);
    renderFailure(legacySignIn, { onRetryTurn: vi.fn() });
    const notice = screen.getByRole("status", { name: "Codex could not finish" });
    expect(notice.textContent).toContain("Sign-in required. Reconnect in Agents & providers on this computer.");
    expect(notice.style.borderColor).toBe("var(--danger)");
    expect(screen.queryByRole("button", { name: /^Retry / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Agents & providers Codex could not finish" }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, opened);
  });

  it("opens the composer model picker for an unavailable model", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 32, height: 32 }] as unknown as DOMRectList);
    renderFailure({ code: "model_unavailable", safeMessage: "Model unavailable. Choose another model.", retryable: false, recoveryActions: ["select_provider"] });
    fireEvent.click(screen.getByRole("button", { name: "Choose model Codex could not finish" }));
    expect(await screen.findByRole("listbox", { name: "Models and connections" })).toBeTruthy();
  });

  it("starts a new Chat for a run that cannot be resumed", () => {
    const { onNewChat } = renderFailure({ code: "run_not_resumable", safeMessage: "Conversation is too long. Start a new chat.", retryable: false, recoveryActions: ["start_new_chat"] });
    fireEvent.click(screen.getByRole("button", { name: "New chat Codex could not finish" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure through the existing turn retry", async () => {
    const onRetryTurn = vi.fn(async () => true);
    const { detail } = renderFailure({ code: "service_unavailable", safeMessage: "Service is busy. Try again shortly.", retryable: true, recoveryActions: ["retry"] }, { onRetryTurn });
    fireEvent.click(screen.getByRole("button", { name: "Retry Codex could not finish" }));
    await waitFor(() => expect(onRetryTurn).toHaveBeenCalledWith(detail.turns[0]!.id));
  });

  it("omits Retry when this surface cannot retry", () => {
    renderFailure({ code: "service_unavailable", safeMessage: "Service is busy. Try again shortly.", retryable: true, recoveryActions: ["retry"] });
    expect(screen.getByRole("status", { name: "Codex could not finish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Retry / })).toBeNull();
  });

  it.each(["admitted", "rejected"] as const)("keeps the newly opened Chat when a %s retry settles after switching away", async (outcome) => {
    const failed = failedDetail({ code: "service_unavailable", safeMessage: "Service is busy. Try again shortly.", retryable: true, recoveryActions: ["retry"] });
    const other = createCanonicalChatFixture("completed").snapshot;
    const { project, activeRun, providerBinding, ...otherChat } = other.chat;
    const otherDetail: CanonicalChatDetailResponse = { record: { chat: otherChat, projectId: project?.projectId, activeRun, providerBinding },
      messages: other.messages, turns: other.turns, runs: other.runs, activities: other.activities };
    let settleRetry: (response: Response) => void = () => undefined;
    let settleOther: () => void = () => undefined;
    stubLegacyChatFetch(vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { settleRetry = resolve; });
      if (url.includes("/api/chats?")) return Promise.resolve(Response.json({ items: [failed.record, otherDetail.record] }));
      if (url.includes(otherChat.id)) return new Promise<Response>((resolve) => { settleOther = () => resolve(Response.json(otherDetail)); });
      return Promise.resolve(Response.json(failed));
    }));
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages.some((message) => message.role === "system")).toBe(true));
    let retried!: Promise<boolean>;
    act(() => { retried = result.current.retryTurn!(failed.turns[0]!.id); });
    act(() => result.current.switchConversation(otherChat.id));
    const { completedAt: _completedAt, outcome: _outcome, ...failedRun } = failed.runs[0]!;
    await act(async () => {
      settleRetry(outcome === "admitted"
        ? Response.json({ record: failed.record, turn: { ...failed.turns[0]!, status: "accepted" },
          run: { ...failedRun, id: "run_retry", attempt: 2, status: "accepted" }, admission: "accepted" })
        : Response.json({ error: { code: "chat_conflict" } }, { status: 409 }));
      await retried;
    });
    // The newly opened Chat's own load answers after the retry settled.
    await act(async () => { settleOther(); });
    await waitFor(() => expect(result.current.messages.map((message) => message.id)).toContain(other.messages[0]!.id));
    expect(result.current.sessionId).toBe(otherChat.id);
    expect(result.current.busy).toBe(false);
    expect(result.current.messages.map((message) => message.id)).toContain(other.messages[0]!.id);
    expect(JSON.stringify(result.current)).not.toContain("could not be retried");
  });

  it("posts the retry for the failed turn against the current Chat revision", async () => {
    const detail = failedDetail({ code: "service_unavailable", safeMessage: "Service is busy. Try again shortly.", retryable: true, recoveryActions: ["retry"] });
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const { completedAt: _completedAt, outcome: _outcome, ...failedRun } = detail.runs[0]!;
        return Response.json({ record: detail.record, turn: { ...detail.turns[0]!, status: "accepted" },
          run: { ...failedRun, id: "run_retry", attempt: 2, status: "accepted" }, admission: "accepted" });
      }
      return Response.json(url.includes("/api/chats?") ? { items: [detail.record] } : detail);
    });
    stubLegacyChatFetch(transport);
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages.some((message) => message.role === "system")).toBe(true));
    await expect(result.current.retryTurn!(detail.turns[0]!.id)).resolves.toBe(true);
    const post = transport.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toContain(`/api/chats/${detail.record.chat.id}/turns/${detail.turns[0]!.id}/runs`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ clientRequestId: expect.any(String), baseRevision: detail.record.chat.revision });
  });
});
