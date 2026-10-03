import { renderHook } from "@testing-library/react-native";

const mockUseQuery = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "test", getToken: jest.fn() }) }));
jest.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => mockUseQuery(options), useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: jest.fn(), fetchChats: jest.fn(),
  mobileQueryKeys: { activeComputer: () => ["computer"], canonicalChats: () => ["chats"], botNavigation: () => ["bots"] },
}));
jest.mock("@/lib/requests/bot-navigation", () => ({ fetchNativeBotNavigation: jest.fn() }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
import { useCanonicalChats } from "../lib/queries/use-canonical-chats";

it("preserves canonical activity order despite newer background timestamps", () => {
  const items = [
    { chat: { id: "chat_latest_input", updatedAt: "2026-09-01T00:00:00Z" } },
    { chat: { id: "chat_background_run", updatedAt: "2026-09-02T00:00:00Z" } },
  ];
  mockUseQuery.mockReturnValueOnce({ data: { handle: "test", runtimeSlot: "primary" } })
    .mockImplementationOnce((options) => ({ data: options.select({ items }) }))
    .mockReturnValueOnce({ data: { ordinaryChatIds: items.map(record => record.chat.id), bots: [] } });
  const { result } = renderHook(() => useCanonicalChats());
  expect(result.current.chats).toEqual(items);
});
