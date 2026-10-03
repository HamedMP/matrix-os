import React from "react";
import { AppState, Text } from "react-native";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockAuth = { userId: "owner", isLoaded: true, isSignedIn: true, getToken: jest.fn(async () => "token") };
const mockFetchChats = jest.fn();
const mockFetchNavigation = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => mockAuth }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
  fetchActiveComputer: async () => ({ handle: "primary", runtimeSlot: "primary", gatewayPath: "/vm/primary" }),
  fetchChats: (...args: unknown[]) => mockFetchChats(...args),
}));
jest.mock("@/lib/requests/bot-navigation", () => ({ fetchNativeBotNavigation: (...args: unknown[]) => mockFetchNavigation(...args) }));
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { mobileQueryKeys } from "@/lib/requests/query-keys";
function Chats() {
  const query = useCanonicalChats();
  return <>
    <Text>{query.isPending ? "loading chats" : "ready chats"}</Text>
    <Text>{query.chats.map(record => record.chat.id).join(",") || "no ordinary chats"}</Text>
    <Text>{query.botConversations.map(bot => `${bot.chatId}:${bot.pendingApprovalCount}`).join(",") || "no bots"}</Text>
  </>;
}
let client: QueryClient;
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({remove:jest.fn()}));
  mockAuth.userId = "owner"; mockAuth.isSignedIn = true;
  mockFetchChats.mockResolvedValue({ items: ["chat_ordinary", "chat_bot", "chat_unknown"].map(id => ({ chat: { id } })) });
  mockFetchNavigation.mockResolvedValue({ ordinaryChatIds: ["chat_ordinary"],
    bots: [{ chatId: "chat_bot", agentId: "bot_research1", name: "Research", pendingApprovalCount: 1 }],
    unresolvedChatIds: ["chat_unknown"], unavailable: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => { cleanup(); await client.cancelQueries(); client.clear(); });
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});
it("projects authenticated ordinary records and Bot reminders without including unresolved identities", async () => {
  render(<QueryClientProvider client={client}><Chats /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("chat_ordinary")).toBeTruthy());
  expect(screen.getByText("chat_bot:1")).toBeTruthy();
  expect(mockFetchNavigation).toHaveBeenCalledWith("token", "https://example.test/vm/primary", ["chat_bot", "chat_ordinary", "chat_unknown"], expect.any(Object));
});
it("clears the previous runtime and signed-out projections before a new binding read settles", async () => {
  const { rerender } = render(<QueryClientProvider client={client}><Chats /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("chat_ordinary")).toBeTruthy());
  mockFetchNavigation.mockImplementation(() => new Promise(() => {}));
  act(() => { client.setQueryData(mobileQueryKeys.activeComputer("owner"), {
    handle: "second", runtimeSlot: "second", gatewayPath: "/vm/second?runtime=second",
  }); });
  await waitFor(() => expect(mockFetchNavigation).toHaveBeenCalledWith("token", "https://example.test/vm/second?runtime=second", expect.any(Array), expect.any(Object)));
  expect(screen.getByText("no ordinary chats")).toBeTruthy();
  expect(screen.getByText("no bots")).toBeTruthy();
  mockAuth.isSignedIn = false;
  rerender(<QueryClientProvider client={client}><Chats /></QueryClientProvider>);
  expect(screen.getByText("no bots")).toBeTruthy();
});

it("pauses navigation polling in the background and refreshes when Native returns", async () => {
  let changeState: ((state: "active" | "background") => void) | undefined;
  const remove = jest.fn();
  const subscribe = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    changeState = listener; return { remove };
  });
  const { unmount } = render(<QueryClientProvider client={client}><Chats /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("chat_ordinary")).toBeTruthy());
  expect(mockFetchNavigation).toHaveBeenCalledTimes(1);
  await act(async () => { changeState?.("background"); });
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(mockFetchNavigation).toHaveBeenCalledTimes(1);
  await act(async () => { changeState?.("active"); });
  await waitFor(() => expect(mockFetchNavigation).toHaveBeenCalledTimes(2));
  unmount();
  expect(remove).toHaveBeenCalled();
  subscribe.mockRestore();
});

it("retains verified classifications during new-ID refresh and drops stale approval counts on failure", async () => {
  render(<QueryClientProvider client={client}><Chats /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("chat_ordinary")).toBeTruthy());
  let reject!: (error: Error) => void;
  mockFetchNavigation.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  act(() => { client.setQueryData(mobileQueryKeys.canonicalChats("owner", "primary:primary"), {
    items: ["chat_ordinary", "chat_bot", "chat_unknown", "chat_new"].map(id => ({ chat: { id } })),
  }); });
  await waitFor(() => expect(mockFetchNavigation).toHaveBeenCalledWith("token", "https://example.test/vm/primary", ["chat_bot", "chat_new", "chat_ordinary", "chat_unknown"], expect.any(Object)));
  expect(screen.getByText("chat_ordinary")).toBeTruthy();
  expect(screen.queryByText(/chat_new/)).toBeNull();
  expect(screen.getByText("ready chats")).toBeTruthy();
  await act(async () => reject(new Error("unavailable")));
  await waitFor(() => expect(screen.getByText("chat_bot:0")).toBeTruthy());
  expect(screen.getByText("chat_ordinary")).toBeTruthy();
});
