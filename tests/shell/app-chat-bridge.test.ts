import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBridgeScript, handleBridgeMessage, type BridgeHandler } from "../../shell/src/lib/os-bridge";
import { openChatFromApp } from "../../shell/src/lib/app-open-chat";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { APP_CHAT_OPERATIONS } from "../../packages/contracts/src/app-chats";

const chatId = "chat_0123456789abcdef";

function port() {
  const postMessage = vi.fn();
  return { postMessage, close: vi.fn() } as unknown as MessagePort & { postMessage: ReturnType<typeof vi.fn> };
}
function openEvent(chat: unknown, ports: MessagePort[]) {
  return { data: { type: "os:open-chat", app: "board", payload: { chatId: chat } }, ports, origin: "", source: null } as unknown as MessageEvent;
}
const handler = (openChat?: BridgeHandler["openChat"]): BridgeHandler => ({ sendToKernel: vi.fn(), fetchData: vi.fn(), ...(openChat ? { openChat } : {}) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("web app bridge for Chat", () => {
  it("injects every Chat operation", () => {
    const script = buildBridgeScript("board");
    for (const operation of APP_CHAT_OPERATIONS) expect(script).toContain(`"${operation}"`);
    expect(script).toContain("chats:");
    expect(script).toContain("openChat:");
  });

  it("keeps raw Chat routes closed so Chat only travels through capabilities", () => {
    for (const url of ["/api/chats", "/api/chat-navigation?version=1", `/api/chats/${chatId}`, "/api/chats/credentials"]) {
      expect(isAllowedBridgeFetchUrl("board", url)).toBe(false);
    }
    expect(isAllowedBridgeFetchUrl("board", "/api/bridge/capabilities", "POST")).toBe(true);
  });

  it("opens a valid Chat and acknowledges it", async () => {
    const reply = port();
    const openChat = vi.fn(async () => undefined);
    handleBridgeMessage(openEvent(chatId, [reply]), handler(openChat));
    await vi.waitFor(() => expect(reply.postMessage).toHaveBeenCalled());
    expect(openChat).toHaveBeenCalledWith(chatId);
    expect(reply.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("rejects a malformed identifier before calling the host", async () => {
    const reply = port();
    const openChat = vi.fn(async () => undefined);
    handleBridgeMessage(openEvent("../settings", [reply]), handler(openChat));
    await vi.waitFor(() => expect(reply.postMessage).toHaveBeenCalledWith({ ok: false }));
    expect(openChat).not.toHaveBeenCalled();
  });
});

describe("openChatFromApp", () => {
  const stub = (body: unknown, ok = true) => {
    const fetchFn = vi.fn(async () => ({ ok, json: async () => body }));
    vi.stubGlobal("fetch", fetchFn);
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal("CustomEvent", class { constructor(public type: string, public init: { detail: unknown }) {} });
    return { fetchFn, dispatch };
  };

  it("checks access under the host-stamped identity before moving the active Chat", async () => {
    const { fetchFn, dispatch } = stub({ ok: true, status: 200, result: {} });
    await openChatFromApp("board", chatId, "https://gateway.test");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.test/api/bridge/capabilities");
    expect(JSON.parse(String(init.body))).toEqual({ app: "board", input: { kind: "chats", request: { op: "get", chatId, limit: 1 } } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not move the active Chat when the app lacks access", async () => {
    const { dispatch } = stub({ ok: false, status: 403, error: { code: "app_chat_denied", safeMessage: "Denied.", retryable: false } });
    await expect(openChatFromApp("board", chatId, "https://gateway.test")).rejects.toThrow("Chat navigation is unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
