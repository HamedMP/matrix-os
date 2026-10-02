// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { useDirectBotChat } from "../../../packages/ui/src/chat-agents/bots/use-direct-bot-chat.js";

afterEach(cleanup);
const clientWith = (lookup: (chatId: string) => Promise<string | null>) => ({ bots: { directBot: lookup } }) as ChatAgentClient;

it("ignores an old lookup after switching Chat or runtime", async () => {
  let finish!: (id: string) => void;
  const oldClient = clientWith(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const newClient = clientWith(vi.fn(async () => null));
  const { result, rerender } = renderHook(({ chatId, client }) => useDirectBotChat(chatId, client), {
    initialProps: { chatId: "chat_bot", client: oldClient },
  });
  rerender({ chatId: "chat_regular", client: newClient });
  expect(result.current).toBeUndefined();
  await act(async () => finish("bot_old_lookup"));
  await waitFor(() => expect(result.current).toBeNull());
  await waitFor(() => expect(newClient.bots!.directBot).toHaveBeenCalledWith("chat_regular"));
});

it("fails closed on lookup failure and never guesses bot identity from a saved provider", async () => {
  const client = clientWith(vi.fn(async () => { throw new Error("unavailable"); }));
  const { result } = renderHook(() => useDirectBotChat("chat_unknown", client));
  await waitFor(() => expect(client.bots!.directBot).toHaveBeenCalledOnce());
  expect(result.current).toBeUndefined();
});

it("shares a parent lookup with the bot panel without querying again", () => {
  const client = clientWith(vi.fn(async () => "bot_test"));
  const { result } = renderHook(() => useDirectBotChat("chat_test", client, "bot_test"));
  expect(result.current).toBe("bot_test");
  expect(client.bots!.directBot).not.toHaveBeenCalled();
});

it("retains the verified bot on a refresh failure and retries without crossing runtime scope", async () => {
  vi.useFakeTimers();
  try {
    const lookup = vi.fn().mockResolvedValueOnce("bot_known").mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null);
    const client = clientWith(lookup);
    const { result, unmount } = renderHook(() => useDirectBotChat("chat_known", client));
    await act(async () => {});
    expect(result.current).toBe("bot_known");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current).toBe("bot_known");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
