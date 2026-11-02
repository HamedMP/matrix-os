import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useAgentChatId } from "../components/agents/use-agent-chat-id";
const mockEnsure = jest.fn(), mockFetch = jest.fn();
const mockSession = jest.fn(async () => ({token: "fixture", gatewayUrl: "https://preview.test"}));
let mockScope = "owner:preview";
jest.mock("../lib/queries/use-active-gateway", () => ({useActiveGateway: () => ({ready: true, userId: mockScope.split(":")[0], computerKey: mockScope.split(":")[1], session: mockSession})}));
jest.mock("../lib/queries/use-agents", () => ({useEnsureAgentChat: () => ({mutate: mockEnsure})}));
jest.mock("../lib/requests/bot-chat-identity", () => ({fetchSavedBotChatIdentity: (...args: unknown[]) => mockFetch(...args)}));
beforeEach(() => {jest.clearAllMocks(); mockScope = "owner:preview";});
const saved = {chatId: "chat_saved", scope: "owner:preview"};
it("reads the retained reverse binding even when the Bot definition is unavailable", async () => {
  mockFetch.mockResolvedValue("bot_saved001");
  const {result} = renderHook(() => useAgentChatId("bot_saved001", "chat_stale", saved));
  expect(result.current.chatId).toBeNull();
  await waitFor(() => expect(result.current.chatId).toBe("chat_saved"));
  expect(mockEnsure).not.toHaveBeenCalled();
});
it("does not create a replacement when the saved binding is missing", async () => {
  mockFetch.mockResolvedValue(null);
  const {result} = renderHook(() => useAgentChatId("bot_saved001", null, saved));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.chatId).toBeNull();
  expect(mockEnsure).not.toHaveBeenCalled();
});
it("refuses a different binding and retries with reads only", async () => {
  mockFetch.mockResolvedValueOnce("bot_replaced001").mockResolvedValue("bot_saved001");
  const {result} = renderHook(() => useAgentChatId("bot_saved001", null, saved));
  await waitFor(() => expect(result.current.failed).toBe(true));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.chatId).toBe("chat_saved"));
  expect(mockEnsure).not.toHaveBeenCalled();
});
it("fences a saved Chat immediately when the owner or Computer changes", async () => {
  let finish!: (id: string) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const {result, rerender} = renderHook(() => useAgentChatId("bot_saved001", "chat_stale", saved));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  mockScope = "other:preview";
  rerender({});
  expect(result.current.chatId).toBeNull();
  await act(async () => finish("bot_saved001"));
  expect(result.current.chatId).toBeNull();
  expect(result.current.failed).toBe(true);
  expect(mockEnsure).not.toHaveBeenCalled();
});
