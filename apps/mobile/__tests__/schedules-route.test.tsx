import { act, cleanup, render } from "@testing-library/react-native";
import SchedulesRoute from "../app/(drawer)/(tabs)/agents/schedules";
import { fetchAgentDirectChat } from "../lib/requests/bots";
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
