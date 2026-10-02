// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useChatCredentialDisclosure } from "@desktop/renderer/src/features/chat/use-chat-credential-disclosure";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, snapshot } from "./canonical-chat-workspace-test-utils";

afterEach(cleanup);

const text = "token=[redacted credential]";
const message = {
  ...snapshot.messages[0]!, id: "msg_secret", role: "assistant" as const,
  state: "committed" as const, parts: [{ type: "text" as const, text }],
};
const detail: CanonicalChatDetailResponse = {
  record: canonicalChatRecord,
  messages: [...snapshot.messages, message],
  turns: snapshot.turns,
  runs: snapshot.runs,
  activities: snapshot.activities,
};
const occurrence = { id: "cred_00000000000000000000000000000001", messageId: message.id, offset: 6, length: 21, revealed: true };

function client(overrides: Partial<CanonicalChatClient> = {}): CanonicalChatClient {
  return {
    ...createCanonicalChatWorkspaceClient(),
    getCredentialOccurrences: vi.fn(async () => [occurrence]),
    getRevealedCredential: vi.fn(async () => "private-test-value"),
    revealCredential: vi.fn(async () => "private-test-value"),
    hideCredential: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("useChatCredentialDisclosure", () => {
  it("rehydrates a previously revealed value after a fresh metadata read, then clears on scope loss", async () => {
    const routeClient = client();
    const hook = renderHook(({ scopeKey }) => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey }),
      { initialProps: { scopeKey: "owner:chat" as string | null } });
    await waitFor(() => expect(hook.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));
    expect(routeClient.getCredentialOccurrences).toHaveBeenCalledWith(detail.record.chat.id, [message.id]);
    expect(routeClient.getRevealedCredential).toHaveBeenCalledWith(detail.record.chat.id, "cred_00000000000000000000000000000001");

    hook.rerender({ scopeKey: null });
    expect(hook.result.current.values).toEqual({});
    expect(hook.result.current.occurrences).toEqual([]);

    hook.rerender({ scopeKey: "owner:chat" });
    await waitFor(() => expect(hook.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));
    expect(routeClient.getRevealedCredential).toHaveBeenCalledTimes(2);
  });

  it("rehydrates from server authority after the renderer is unmounted and recreated", async () => {
    const routeClient = client();
    const first = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(first.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));
    first.unmount();
    const restarted = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(restarted.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));
    expect(routeClient.getRevealedCredential).toHaveBeenCalledTimes(2);
  });

  it("removes plaintext immediately when hide starts and keeps it hidden after success", async () => {
    let finishHide!: () => void;
    const routeClient = client({ hideCredential: vi.fn(() => new Promise<void>((resolve) => { finishHide = resolve; })) });
    const hook = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(hook.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));

    let hidePromise!: Promise<void>;
    act(() => { hidePromise = hook.result.current.hide("cred_00000000000000000000000000000001"); });
    expect(hook.result.current.values).toEqual({});
    await act(async () => { finishHide(); await hidePromise; });
    expect(hook.result.current.occurrences[0]?.revealed).toBe(false);
    expect(hook.result.current.values).toEqual({});
  });

  it("does not restore plaintext from an in-flight rehydration after hide starts", async () => {
    let finishRead!: (value: string) => void;
    let finishHide!: () => void;
    const routeClient = client({
      getRevealedCredential: vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; })),
      hideCredential: vi.fn(() => new Promise<void>((resolve) => { finishHide = resolve; })),
    });
    const hook = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(routeClient.getRevealedCredential).toHaveBeenCalled());
    let hidePromise!: Promise<void>;
    act(() => { hidePromise = hook.result.current.hide(occurrence.id); });
    await act(async () => { finishRead("private-test-value"); });
    expect(hook.result.current.values).toEqual({});
    await act(async () => { finishHide(); await hidePromise; });
    expect(hook.result.current.values).toEqual({});
  });

  it("does not rehydrate after a durable manual hide and renderer restart", async () => {
    let serverRevealed = true;
    const routeClient = client({
      getCredentialOccurrences: vi.fn(async () => [{ ...occurrence, revealed: serverRevealed }]),
      hideCredential: vi.fn(async () => { serverRevealed = false; }),
    });
    const first = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(first.result.current.values.cred_00000000000000000000000000000001).toBe("private-test-value"));
    await act(async () => { await first.result.current.hide("cred_00000000000000000000000000000001"); });
    first.unmount();

    const restarted = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(restarted.result.current.loaded).toBe(true));
    expect(restarted.result.current.occurrences[0]?.revealed).toBe(false);
    expect(restarted.result.current.values).toEqual({});
    expect(routeClient.getRevealedCredential).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight value response after authorization changes", async () => {
    let finishRead!: (value: string) => void;
    const routeClient = client({ getRevealedCredential: vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; })) });
    const hook = renderHook(({ scopeKey }) => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey }),
      { initialProps: { scopeKey: "owner:chat" as string | null } });
    await waitFor(() => expect(routeClient.getRevealedCredential).toHaveBeenCalled());

    hook.rerender({ scopeKey: null });
    await act(async () => { finishRead("private-test-value"); });
    expect(hook.result.current.values).toEqual({});
  });

  it("records a failed rehydration without disclosing data and still permits a durable hide", async () => {
    const routeClient = client({ getRevealedCredential: vi.fn(async () => { throw new Error("unavailable"); }) });
    const hook = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(hook.result.current.unavailable).toContain("cred_00000000000000000000000000000001"));
    expect(hook.result.current.values).toEqual({});
    await act(async () => { await hook.result.current.hide("cred_00000000000000000000000000000001"); });
    expect(routeClient.hideCredential).toHaveBeenCalledWith(detail.record.chat.id, "cred_00000000000000000000000000000001");
    expect(hook.result.current.occurrences[0]?.revealed).toBe(false);
    expect(hook.result.current.unavailable).toEqual([]);
  });

  it("fails closed when owner-only metadata cannot be read", async () => {
    const routeClient = client({ getCredentialOccurrences: vi.fn(async () => { throw new Error("offline"); }) });
    const hook = renderHook(() => useChatCredentialDisclosure({ client: routeClient, detail, scopeKey: "owner:chat" }));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.occurrences).toEqual([]);
    expect(hook.result.current.values).toEqual({});
    expect(hook.result.current.availabilityFailed).toBe(true);
    expect(routeClient.getRevealedCredential).not.toHaveBeenCalled();
  });
});
