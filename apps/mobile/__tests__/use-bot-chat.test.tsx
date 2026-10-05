import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

const mockFetchNativeBotChat = jest.fn();

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/requests/bots", () => ({
  ...jest.requireActual("@/lib/requests/bots"),
  fetchNativeBotChat: (...args: unknown[]) => mockFetchNativeBotChat(...args),
}));

import { useBotChat } from "@/lib/queries/use-bot-chat";
import { BotStatusUnsupportedError, type NativeBotChatSnapshot } from "@/lib/requests/bots";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

const GATEWAY = "https://example.test/vm/test";
const BOT_KEY = mobileQueryKeys.botChat("user_a", GATEWAY, "chat_1");
const snapshot = { agentId: "bot_research1", name: "Writer" } as NativeBotChatSnapshot;

function setup(seed?: (queryClient: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, staleTime: 0 } } });
  seed?.(queryClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useBotChat("chat_1", GATEWAY), { wrapper });
  return { queryClient, view };
}

afterEach(() => jest.clearAllMocks());

it("shows an ordinary chat, not an error, on a computer without the bot-status route", async () => {
  mockFetchNativeBotChat.mockRejectedValue(new BotStatusUnsupportedError());
  const { queryClient, view } = setup();

  await waitFor(() => expect(queryClient.getQueryState(BOT_KEY)?.status).toBe("error"));

  expect(view.result.current.isError).toBe(false);
  expect(view.result.current.snapshot).toBeNull();
  // Asking again straight away would get the same answer.
  expect(mockFetchNativeBotChat).toHaveBeenCalledTimes(1);
  view.unmount();
  queryClient.clear();
});

it("reports a status read that failed, after one retry", async () => {
  mockFetchNativeBotChat.mockRejectedValue(new Error("Bot status could not be loaded. Try again."));
  const { queryClient, view } = setup();

  await waitFor(() => expect(view.result.current.isError).toBe(true));

  expect(mockFetchNativeBotChat).toHaveBeenCalledTimes(2);
  view.unmount();
  queryClient.clear();
});

it("keeps a known bot's controls and reports the failed refresh when its route goes missing", async () => {
  mockFetchNativeBotChat.mockRejectedValue(new BotStatusUnsupportedError());
  const { queryClient, view } = setup((client) => client.setQueryData(BOT_KEY, snapshot, { updatedAt: 1 }));

  await waitFor(() => expect(queryClient.getQueryState(BOT_KEY)?.status).toBe("error"));

  expect(view.result.current.snapshot).toEqual(snapshot);
  expect(view.result.current.isError).toBe(true);
  view.unmount();
  queryClient.clear();
});

it("does not read an ordinary chat's bot status again once the computer has answered", async () => {
  mockFetchNativeBotChat.mockResolvedValue(null);
  const { queryClient, view } = setup((client) => client.setQueryData(BOT_KEY, null, { updatedAt: 1 }));

  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(mockFetchNativeBotChat).not.toHaveBeenCalled();
  expect(view.result.current.isError).toBe(false);
  view.unmount();
  queryClient.clear();
});
