const mockSelectChat = jest.fn();
const mockInvalidateChats = jest.fn(() => Promise.resolve());
const mockShowChatScreen = jest.fn();
const mockCreate = jest.fn();
const mockUseBotRecipes = jest.fn();
let mockComputer: { gatewayPath: string } | undefined;
const mockCatalog = { instances: [] };

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: "user_a" }) }));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ selectChat: mockSelectChat }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChats: () => ({ computer: mockComputer, invalidate: mockInvalidateChats }),
}));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog }),
}));
jest.mock("@/lib/queries/use-bot-recipes", () => ({
  useBotRecipes: (...args: unknown[]) => mockUseBotRecipes(...args),
}));
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockShowChatScreen }));

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import AgentsScreen from "../app/(drawer)/(tabs)/agents/index";
import { BotRecipeChooser } from "../components/BotRecipeChooser";
import { HOSTED_GATEWAY_URL } from "../lib/storage";

import { flat } from "./ui-test-utils";

const recipe = {
  recipeId: "inbox-triage",
  version: "v1",
  name: "Inbox triage",
  description: "Sorts new mail",
  output: "A triaged inbox",
};
const gatewayUrl = `${HOSTED_GATEWAY_URL}/vm/solar-vale`;

describe("agents tab root", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComputer = { gatewayPath: "/vm/solar-vale" };
    mockUseBotRecipes.mockReturnValue({ recipes: [recipe], isPending: false, isError: false, create: mockCreate });
  });

  afterEach(cleanup);

  it("starts below the status bar with the Agents title and no top bar", () => {
    render(
      <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
        <AgentsScreen />
      </SafeAreaInsetsContext.Provider>,
    );

    const title = screen.getByRole("header", { name: "Agents" });
    expect(flat(title)).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 30,
      lineHeight: 41,
      color: "#242323",
      marginTop: 8,
      marginHorizontal: 20,
    });
    expect(flat(screen.root).paddingTop).toBe(62);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("reads the recipes of the signed-in computer as soon as the tab is shown", () => {
    render(<AgentsScreen />);

    expect(mockUseBotRecipes).toHaveBeenCalledWith(gatewayUrl, true);
  });

  it("shows the recipe chooser once the recipes are loaded, with no toggle to open it", () => {
    render(<AgentsScreen />);

    expect(screen.getByRole("button", { name: "Use Inbox triage" })).toBeTruthy();
    expect(screen.getByLabelText("Search bot recipes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bot recipes" })).toBeNull();
    expect(screen.UNSAFE_getByType(BotRecipeChooser).props).toMatchObject({
      catalog: mockCatalog,
      recipes: [recipe],
      onCreate: mockCreate,
      attemptScope: `user_a:${gatewayUrl}`,
    });
    expect(screen.UNSAFE_getByType(BotRecipeChooser).props.attemptRef).toEqual({ current: null });
  });

  it("says so while the recipes are loading", () => {
    mockUseBotRecipes.mockReturnValue({ recipes: [], isPending: true, isError: false, create: mockCreate });
    render(<AgentsScreen />);

    expect(screen.getByText("Loading bot recipes…")).toBeTruthy();
    expect(screen.UNSAFE_queryByType(BotRecipeChooser)).toBeNull();
  });

  it("reports a failed load as an alert, without the server's words", () => {
    mockUseBotRecipes.mockReturnValue({ recipes: [], isPending: false, isError: true, create: mockCreate });
    render(<AgentsScreen />);

    const alert = screen.getByRole("alert");
    expect(alert.props.children).toBe("Bot recipes could not be loaded. Try again.");
    expect(screen.UNSAFE_queryByType(BotRecipeChooser)).toBeNull();
  });

  it("shows only the title while no computer is known", () => {
    mockComputer = undefined;
    render(<AgentsScreen />);

    expect(mockUseBotRecipes).toHaveBeenCalledWith(null, true);
    expect(screen.getByRole("header", { name: "Agents" })).toBeTruthy();
    expect(screen.UNSAFE_queryByType(BotRecipeChooser)).toBeNull();
    expect(screen.queryByText("Loading bot recipes…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens the new agent's chat on the Chats tab once the server has created it", async () => {
    let finishCreate: (chatId: string) => void = () => {};
    mockCreate.mockReturnValue(new Promise<string>((resolve) => { finishCreate = resolve; }));
    render(<AgentsScreen />);

    fireEvent.press(screen.getByRole("button", { name: "Use Inbox triage" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toEqual({ recipeId: "inbox-triage", version: "v1" });
    // Nothing moves until the server answers.
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();

    finishCreate("chat_new_agent");
    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalledTimes(1));
    expect(mockSelectChat).toHaveBeenCalledWith("chat_new_agent");
    expect(mockInvalidateChats).toHaveBeenCalledTimes(1);
  });

  it("stays on the Agents tab when the agent could not be created", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockCreate.mockRejectedValue(new Error("upstream said no"));
    render(<AgentsScreen />);

    fireEvent.press(screen.getByRole("button", { name: "Use Inbox triage" }));

    expect(await screen.findByText("Bot could not be created. Try again.")).toBeTruthy();
    expect(screen.queryByText(/upstream said no/)).toBeNull();
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
