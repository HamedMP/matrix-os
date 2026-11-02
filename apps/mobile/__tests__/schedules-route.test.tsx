import { act, cleanup, render } from "@testing-library/react-native";
import SchedulesRoute from "../app/(drawer)/(tabs)/agents/schedules";
import { fetchAgentDirectChat } from "../lib/requests/bots";
let mockProps: Parameters<typeof import("../components/agents/schedules/SchedulesScreen").SchedulesScreen>[0];
const mockPush = jest.fn();
let mockGateway: {ready: boolean; userId: string; computerKey: string; session: jest.Mock};
jest.mock("expo-router", () => ({useRouter: () => ({push: mockPush, back: jest.fn()})}));
jest.mock("../lib/queries/use-active-gateway", () => ({useActiveGateway: () => mockGateway}));
jest.mock("../lib/requests/bots", () => ({fetchAgentDirectChat: jest.fn(), resolveNativeBotInteraction: jest.fn()}));
jest.mock("../lib/canonical-chat-session-context", () => ({useCanonicalChatSession: () => ({selectChat: jest.fn()})}));
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
  await act(async () => mockProps.onOpenChat!("chat_saved", "bot_saved"));
  expect(mockPush).toHaveBeenCalledWith({pathname: "/agents/[agentId]", params: {agentId: "bot_saved", scheduleChatId: "chat_saved", scheduleScope: "owner:preview"}});
  expect(fetchAgentDirectChat).not.toHaveBeenCalled();
});
