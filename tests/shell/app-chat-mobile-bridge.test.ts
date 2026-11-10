import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildMobileAppBridgeScript, createMobileAppCapabilityBroker } from "../../apps/mobile/lib/app-capability-bridge";

const runtime = "https://app.matrix-os.com/vm/test/apps/board/?session=private";
const chatId = "chat_0123456789abcdef";

function launch(reply: unknown, openChat?: (id: string) => void) {
  let context: ReturnType<typeof createContext>;
  const request = vi.fn(async (_path: string, _init: RequestInit) => Response.json(reply));
  const broker = createMobileAppCapabilityBroker({ app: "board", runtimeUrl: runtime, launchId: "launch", request, openChat, reply: script => runInContext(script, context) });
  context = createContext({ setTimeout, clearTimeout, console, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
  runInContext(buildMobileAppBridgeScript("board", "launch"), context);
  return { context, request, broker };
}

describe("Native Mobile app bridge for Chat", () => {
  it("sends Chat operations under the stamped app identity and unwraps the reply", async () => {
    const { context, request, broker } = launch({ ok: true, status: 200, result: { items: [] } });
    expect(await runInContext("window.MatrixOS.chats.navigation({limit:5})", context)).toEqual({ items: [] });
    expect(JSON.parse(request.mock.calls[0]![1].body as string)).toEqual({ app: "board", input: { kind: "chats", request: { op: "navigation", limit: 5 } } });
    broker.dispose();
  });

  it("opens a Chat only after the gateway confirms the app can read it", async () => {
    const openChat = vi.fn();
    const { context, broker } = launch({ ok: true, status: 200, result: {} }, openChat);
    await runInContext(`window.MatrixOS.openChat({view:"chat",chatId:"${chatId}"})`, context);
    expect(openChat).toHaveBeenCalledWith(chatId);
    broker.dispose();
  });

  it("does not open a Chat when the app lacks access", async () => {
    const openChat = vi.fn();
    const { context, broker } = launch({ ok: false, status: 403, error: { code: "app_chat_denied", safeMessage: "Denied.", retryable: false } }, openChat);
    await expect(runInContext(`window.MatrixOS.openChat({view:"chat",chatId:"${chatId}"})`, context)).rejects.toThrow("App request unavailable");
    expect(openChat).not.toHaveBeenCalled();
    broker.dispose();
  });
});
