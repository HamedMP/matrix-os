const mockUseQuery = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "test", getToken: jest.fn() }) }));
jest.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => mockUseQuery(options), useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: jest.fn(), fetchChats: jest.fn(),
  mobileQueryKeys: { activeComputer: () => ["computer"], canonicalChats: () => ["chats"] },
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
import { useCanonicalChats } from "../lib/queries/use-canonical-chats";

it("preserves canonical activity order despite newer background timestamps", () => {
  const items = [
    { chat: { id: "chat_latest_input", updatedAt: "2026-09-01T00:00:00Z" } },
    { chat: { id: "chat_background_run", updatedAt: "2026-09-02T00:00:00Z" } },
  ];
  mockUseQuery.mockReturnValueOnce({ data: { handle: "test", runtimeSlot: "primary" } })
    .mockImplementationOnce((options) => ({ data: options.select({ items }) }));
  expect(useCanonicalChats().chats).toEqual(items);
});
