import { expect, it, vi } from "vitest";
import { createDesktopAoedeFetcher } from "../../desktop/src/renderer/src/lib/aoede-desktop";

it("pins bootstrap, history, events and ticket grants to the captured runtime", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ transport: { kind: "relayed_websocket", url: "/ws/chats/chat_a/voice/vs_a", ticket: "vt_fixture", epoch: 1 } }), { headers: { "content-type": "application/json" } }));
  const captured = createDesktopAoedeFetcher({ baseUrl: "https://platform.test", runtimeSlot: "pr-100", fetcher });
  const response = await captured("https://platform.test/api/chats/chat_a/voice/sessions", { method: "POST" });
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://platform.test/api/chats/chat_a/voice/sessions?runtime=pr-100");
  expect((await response.json()).transport.url).toBe("wss://platform.test/vm/pr-100/ws/chats/chat_a/voice/vs_a");
  await expect(captured("https://other.test/api/aoede/bootstrap")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
