import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";

const kernel = vi.hoisted(() => ({
  abortKernelRequest: vi.fn(),
  sendKernelMessage: vi.fn(),
}));

vi.mock("@desktop/renderer/src/lib/kernel-wiring", () => kernel);

describe("useHermesChat", () => {
  beforeEach(() => {
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    kernel.abortKernelRequest.mockReset();
    kernel.sendKernelMessage.mockReset();
    kernel.sendKernelMessage.mockReturnValue(true);
  });

  it("aborts the active kernel request before starting a new chat", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId;

    useHermesChat.getState().newChat();

    expect(requestId).toEqual(expect.any(String));
    expect(kernel.abortKernelRequest).toHaveBeenCalledWith(requestId);
    expect(useHermesChat.getState()).toMatchObject({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
    });
  });

  it("returns to idle and shows an error when the kernel socket is unavailable", () => {
    kernel.sendKernelMessage.mockReturnValue(false);

    useHermesChat.getState().send("hello");

    expect(useHermesChat.getState().status).toBe("idle");
    expect(useHermesChat.getState().activeRequestId).toBeNull();
    expect(useHermesChat.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({
        role: "system",
        content: "Can't reach Matrix OS. Check your connection.",
      }),
    ]);
  });

  it("returns to idle when abort cannot be sent", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId;
    kernel.abortKernelRequest.mockReturnValue(false);

    useHermesChat.getState().abort();

    expect(kernel.abortKernelRequest).toHaveBeenCalledWith(requestId);
    expect(useHermesChat.getState()).toMatchObject({
      status: "idle",
      activeRequestId: null,
    });
  });

  it("shows a late error for the visible request after an earlier result event", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;

    useHermesChat.getState().ingest({ type: "kernel:result", requestId });
    useHermesChat.getState().ingest({
      type: "kernel:error",
      message: "Request failed",
      requestId,
    });

    expect(useHermesChat.getState()).toMatchObject({
      status: "idle",
      activeRequestId: null,
      messages: [
        expect.objectContaining({ role: "user", content: "hello", requestId }),
        expect.objectContaining({ role: "system", content: "Request failed", requestId }),
      ],
    });
  });

  it("keeps a newer request active when an older request reports a late error", () => {
    useHermesChat.getState().send("first");
    const firstRequestId = useHermesChat.getState().activeRequestId!;
    useHermesChat.getState().ingest({
      type: "kernel:result",
      requestId: firstRequestId,
    });

    useHermesChat.getState().send("second");
    const secondRequestId = useHermesChat.getState().activeRequestId!;
    useHermesChat.getState().ingest({
      type: "kernel:error",
      message: "First request failed",
      requestId: firstRequestId,
    });

    expect(useHermesChat.getState()).toMatchObject({
      status: "thinking",
      activeRequestId: secondRequestId,
      messages: [
        expect.objectContaining({ role: "user", content: "first", requestId: firstRequestId }),
        expect.objectContaining({ role: "user", content: "second", requestId: secondRequestId }),
        expect.objectContaining({ role: "system", content: "First request failed", requestId: firstRequestId }),
      ],
    });
  });

  it("binds the kernel session only for the active request", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;

    useHermesChat.getState().ingest({
      type: "kernel:init",
      sessionId: "session-current",
      requestId,
    });

    expect(useHermesChat.getState().sessionId).toBe("session-current");
  });

  it("ignores a late init after New clears the active request", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;
    useHermesChat.getState().newChat();

    useHermesChat.getState().ingest({
      type: "kernel:init",
      sessionId: "session-stale",
      requestId,
    });

    expect(useHermesChat.getState().sessionId).toBeNull();
  });
});
