import { act, cleanup, render } from "@testing-library/react-native";
import SchedulesRoute from "../app/(drawer)/(tabs)/agents/schedules";
import type { BotInteraction, ResolveBotInteractionRequest } from "@matrix-os/contracts";
import { fetchAgentDirectChat, resolveNativeBotInteraction } from "../lib/requests/bots";
let mockProps: Parameters<typeof import("../components/agents/schedules/SchedulesScreen").SchedulesScreen>[0];
const mockPush = jest.fn();
const mockSelectChat = jest.fn();
const mockShowChat = jest.fn();
let mockGateway: {ready: boolean; userId: string; computerKey: string; session: jest.Mock};
jest.mock("expo-router", () => ({useRouter: () => ({push: mockPush, back: jest.fn()})}));
jest.mock("../lib/queries/use-active-gateway", () => ({useActiveGateway: () => mockGateway}));
jest.mock("../lib/requests/bots", () => ({fetchAgentDirectChat: jest.fn(), resolveNativeBotInteraction: jest.fn()}));
jest.mock("../lib/use-shell-navigation", () => ({useShowChatScreen: () => mockShowChat}));
jest.mock("../lib/canonical-chat-session-context", () => ({useCanonicalChatSession: () => ({selectChat: mockSelectChat})}));
jest.mock("../lib/requests/routines", () => ({createNativeRoutineClient: () => ({})}));
jest.mock("../components/agents/schedules/SchedulesScreen", () => ({SchedulesScreen: (value: typeof mockProps) => {mockProps = value; return null;}}));
jest.mock("../components/shell/TabScreen", () => ({TabScreen: () => null}));
jest.mock("../components/ui", () => ({Button: () => null}));
beforeEach(() => {
  jest.clearAllMocks();
  mockGateway = {ready: true, userId: "owner", computerKey: "preview", session: jest.fn(async () => ({token: "fixture", gatewayUrl: "https://preview.test"}))};
});
afterEach(cleanup);
it("carries the exact saved Chat and owner/Computer scope into the read-only Bot Chat path", async () => {
  render(<SchedulesRoute/>);
  await act(async () => mockProps.onOpenChat!("chat_saved", "bot_saved001"));
  expect(mockPush).toHaveBeenCalledWith({pathname: "/agents/[agentId]", params: {agentId: "bot_saved001", scheduleChatId: "chat_saved", scheduleScope: "owner:preview"}});
  expect(fetchAgentDirectChat).not.toHaveBeenCalled();
});
it("selects the original Chat and leaves the Schedules screen for a source Chat", async () => {
  render(<SchedulesRoute />);
  await act(async () => mockProps.onOpenChat!("chat_source"));
  expect(mockSelectChat).toHaveBeenCalledWith("chat_source");
  expect(mockShowChat).toHaveBeenCalledTimes(1);
  expect(mockPush).not.toHaveBeenCalled();
});

it("renews the bearer when retrying a scheduled Bot approval after wake", async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const random = jest.spyOn(Math, "random").mockReturnValue(0);
  const resolve = jest.mocked(resolveNativeBotInteraction);
  resolve.mockImplementation(jest.requireActual("../lib/requests/bots").resolveNativeBotInteraction);
  let token = "first-token";
  const gatewayUrl = "https://preview.test";
  mockGateway.session.mockResolvedValue({ token, getToken: async () => token, gatewayUrl });
  const interaction: BotInteraction = {
    interactionId: "in_abcdefgh", chatId: "chat_saved", agentId: "bot_saved001", taskId: "task_abcdefgh",
    kind: "approval", blocking: true, status: "pending", expiresAt: "2026-11-27T08:00:00.000Z", revision: 3,
  };
  const input: ResolveBotInteractionRequest = { kind: "approval", baseRevision: 3, decision: "approve" };
  const approved = { interaction: { interactionId: interaction.interactionId, status: "resolved", revision: 4 } };
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    token = "fresh-token";
    return {
      ok: false, status: 503, headers: { get: () => "1" },
      clone: () => ({ text: async () => JSON.stringify({ runtimeState: "waking" }) }),
    } as unknown as Response;
  }).mockImplementation(async (_url, init) => {
    const authorized = (init?.headers as Record<string, string>).Authorization === "Bearer fresh-token";
    return { ok: authorized, status: authorized ? 200 : 401, json: async () => approved } as Response;
  });
  try {
    render(<SchedulesRoute />);
    await act(async () => {
      await Promise.all([
        expect(mockProps.resolve(interaction, input)).resolves.toEqual(approved),
        jest.advanceTimersByTimeAsync(1_100),
      ]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = `${gatewayUrl}/api/chats/${interaction.chatId}/interactions/${interaction.interactionId}/resolve?includeRecovery=true`;
    for (const [index, bearer] of ["first-token", "fresh-token"].entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(index + 1, url, expect.objectContaining({
        method: "POST", body: JSON.stringify(input),
        headers: expect.objectContaining({ Authorization: `Bearer ${bearer}` }),
      }));
    }
  } finally {
    resolve.mockReset();
    fetchMock.mockRestore();
    warn.mockRestore();
    random.mockRestore();
    jest.useRealTimers();
  }
});
