import React, { type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useCanonicalChatDetail } from "../lib/queries/use-canonical-chat-detail";

const mockFetchChatDetail = jest.fn();
// The shared contracts barrel pulls in ESM-only micromark, which this Jest suite cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: async () => "clerk-token", isLoaded: true, isSignedIn: true, userId: "owner" }),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({ useCanonicalChatSession: () => ({ streamLive: true }) }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: jest.fn(async () => ({ handle: "test", runtimeSlot: "primary", gatewayPath: "/vm/test" })),
  fetchChatDetail: (...args: unknown[]) => mockFetchChatDetail(...args),
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
}));

function detailFor(chatId: string) {
  return { record: { chat: { id: chatId, revision: 1 } }, messages: [], turns: [], runs: [], activities: [] };
}

const fetchesOf = (chatId: string) => mockFetchChatDetail.mock.calls.filter((call) => call[2] === chatId).length;

it("reconciles a chat with the gateway every time it is opened", async () => {
  mockFetchChatDetail.mockImplementation(async (_token: string, _gatewayUrl: string, chatId: string) => detailFor(chatId));
  // The app's defaults: data counts as fresh for 30s unless a query says otherwise.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ chatId }: { chatId: string }) => useCanonicalChatDetail(chatId),
    { wrapper, initialProps: { chatId: "chat_one" } },
  );
  await waitFor(() => expect(result.current.detail?.record.chat.id).toBe("chat_one"));

  rerender({ chatId: "chat_two" });
  await waitFor(() => expect(result.current.detail?.record.chat.id).toBe("chat_two"));
  expect(fetchesOf("chat_one")).toBe(1);

  // Events for a chat that is not open are not applied to it, so what is
  // cached for it may be behind however recently it was fetched.
  rerender({ chatId: "chat_one" });
  await waitFor(() => expect(fetchesOf("chat_one")).toBe(2));

  unmount();
  queryClient.clear();
});
