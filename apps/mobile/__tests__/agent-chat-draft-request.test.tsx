import { act, renderHook } from "@testing-library/react-native";

import {
  consumeChatDraftRequest,
  requestChatDraft,
  useChatDraftRequest,
} from "../components/agents/chat-draft-request";

describe("chat draft request", () => {
  afterEach(() => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());
    if (result.current) act(() => consumeChatDraftRequest(result.current!.id));
    unmount();
  });

  it("is empty until a screen asks for a draft", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());

    expect(result.current).toBeNull();
    unmount();
  });

  it("hands the requested text to a screen that is already listening", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());

    act(() => requestChatDraft("Help me create a Matrix agent"));

    expect(result.current).toMatchObject({ text: "Help me create a Matrix agent" });
    unmount();
  });

  it("keeps the request for a screen that starts listening afterwards", () => {
    requestChatDraft("Asked before the chat screen was on screen");

    const { result, unmount } = renderHook(() => useChatDraftRequest());

    expect(result.current?.text).toBe("Asked before the chat screen was on screen");
    unmount();
  });

  it("is taken once: consuming it empties it", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());
    act(() => requestChatDraft("First"));

    act(() => consumeChatDraftRequest(result.current!.id));

    expect(result.current).toBeNull();
    unmount();
  });

  it("gives each request its own id, and a later request replaces an untaken one", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());
    act(() => requestChatDraft("First"));
    const first = result.current!;

    act(() => requestChatDraft("Second"));

    expect(result.current!.text).toBe("Second");
    expect(result.current!.id).not.toBe(first.id);
    unmount();
  });

  it("does not let a stale consumer drop a newer request", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());
    act(() => requestChatDraft("First"));
    const first = result.current!;
    act(() => requestChatDraft("Second"));

    act(() => consumeChatDraftRequest(first.id));

    expect(result.current?.text).toBe("Second");
    unmount();
  });

  it("ignores a request with no text", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());

    act(() => requestChatDraft("   "));

    expect(result.current).toBeNull();
    unmount();
  });

  it("stops telling a screen that has gone", () => {
    const { result, unmount } = renderHook(() => useChatDraftRequest());
    unmount();

    expect(() => requestChatDraft("After the chat screen left")).not.toThrow();
    expect(result.current).toBeNull();
  });
});
