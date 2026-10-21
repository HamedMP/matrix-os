import { act, cleanup, render } from "@testing-library/react-native";

import type { ActiveChatScreenProps } from "../components/chat/ActiveChatScreen";
import ProjectChatRoute from "../app/(drawer)/(tabs)/(chats)/projects/[projectId]/chats/[chatId]";

const mockRouter = {
  back: jest.fn(),
  replace: jest.fn(),
  dismissTo: jest.fn(),
  canGoBack: jest.fn(() => true),
};
let mockParams: { projectId?: string | string[]; chatId?: string | string[] } = {};
const mockSelectChat = jest.fn();
let mockActiveChatId: string | null = null;
let mockScreenProps: ActiveChatScreenProps | null = null;

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ activeChatId: mockActiveChatId, selectChat: mockSelectChat }),
}));
// The chat itself is drawn and tested as the Chats tab's own screen.
jest.mock("@/components/chat/ActiveChatScreen", () => ({
  ActiveChatScreen: (props: ActiveChatScreenProps) => {
    mockScreenProps = props;
    return null;
  },
}));

function shown(): ActiveChatScreenProps {
  if (!mockScreenProps) throw new Error("The chat was not drawn");
  return mockScreenProps;
}

describe("project chat route", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRouter)) mock.mockClear();
    mockRouter.canGoBack.mockReturnValue(true);
    mockSelectChat.mockClear();
    mockParams = { projectId: "proj_portfolio", chatId: "chat_landing" };
    mockActiveChatId = "chat_landing";
    mockScreenProps = null;
  });

  afterEach(cleanup);

  it("goes back to the project's chats", () => {
    render(<ProjectChatRoute />);

    act(() => shown().onBack?.());

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("goes to the project when a link opened the chat with nothing beneath it", () => {
    mockRouter.canGoBack.mockReturnValue(false);
    render(<ProjectChatRoute />);

    act(() => shown().onBack?.());

    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith("/projects/proj_portfolio");
  });

  it("starts a new chat on the project's own screen, which puts the cursor in its composer", () => {
    render(<ProjectChatRoute />);

    act(() => shown().onNewChat?.());

    expect(mockRouter.dismissTo).toHaveBeenCalledWith({
      pathname: "/projects/[projectId]",
      params: { projectId: "proj_portfolio", newChat: "1" },
    });
  });

  it("opens the chat its link names when another chat is open", () => {
    mockActiveChatId = "chat_case";
    render(<ProjectChatRoute />);

    expect(mockSelectChat).toHaveBeenCalledTimes(1);
    expect(mockSelectChat).toHaveBeenCalledWith("chat_landing");
  });

  it("leaves the open chat alone when it is the one the link names, as when a project row opened it", () => {
    render(<ProjectChatRoute />);

    expect(mockSelectChat).not.toHaveBeenCalled();
  });

  it.each<[string, typeof mockParams]>([
    ["no project", { chatId: "chat_landing" }],
    ["more than one project", { projectId: ["proj_portfolio", "proj_matrix"], chatId: "chat_landing" }],
  ])("goes back to the projects list for a link with %s", (_case, params) => {
    mockParams = params;
    mockRouter.canGoBack.mockReturnValue(false);
    render(<ProjectChatRoute />);

    act(() => shown().onBack?.());
    act(() => shown().onNewChat?.());

    expect(mockRouter.replace).toHaveBeenCalledWith("/projects");
    expect(mockRouter.dismissTo).toHaveBeenCalledWith("/projects");
  });

  it.each<[string, typeof mockParams]>([
    ["no chat", { projectId: "proj_portfolio" }],
    ["more than one chat", { projectId: "proj_portfolio", chatId: ["chat_landing", "chat_case"] }],
  ])("opens nothing for a link with %s", (_case, params) => {
    mockParams = params;
    mockActiveChatId = "chat_case";
    render(<ProjectChatRoute />);

    expect(mockSelectChat).not.toHaveBeenCalled();
  });
});
