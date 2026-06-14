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
});
