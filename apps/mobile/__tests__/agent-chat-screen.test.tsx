import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { FlatList, KeyboardAvoidingView, Platform, Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { AgentChatScreen, type AgentChatScreenProps } from "../components/agents/AgentChatScreen";
import { ModelTrigger } from "../components/chat/ModelTrigger";
import { AgentMascot } from "../components/ui/AgentMascot";
import { Icon } from "../components/ui/Icon";
import { BackIcon, InfoIcon, MicIcon } from "../components/ui/icons";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

let mockKeyboardVisible = false;
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));

function message(fields: Pick<TranscriptMessage, "id" | "role" | "text">): TranscriptMessage {
  return { toolCalls: [], activities: [], isRunning: false, createdAt: 0, ...fields };
}

const reply = message({ id: "msg_reply", role: "assistant", text: "Brief ready for your call." });
const asked = message({ id: "msg_user", role: "user", text: "Who am I meeting next?" });

function screenProps(overrides: Partial<AgentChatScreenProps> = {}): AgentChatScreenProps {
  return {
    agent: { id: "bot_research1", name: "Account research", category: "sales" },
    state: "ready",
    onBack: jest.fn(),
    onOpenDetails: jest.fn(),
    onRetry: jest.fn(),
    messages: [reply, asked],
    chatId: "chat_research",
    composer: { draft: "", onChangeDraft: jest.fn(), canSend: false, onSend: jest.fn() },
    ...overrides,
  };
}

function renderScreen(overrides: Partial<AgentChatScreenProps> = {}) {
  const props = screenProps(overrides);
  const view = render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <AgentChatScreen {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return { props, ...view };
}

describe("agent chat screen", () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    cleanup();
    mockKeyboardVisible = false;
    Platform.OS = originalPlatform;
  });

  describe("top bar", () => {
    it("is start-aligned: back, the agent's 32pt mascot, then its name, with no subtitle", () => {
      renderScreen();

      const bar = screen.getByTestId("agent-chat-top-bar");
      expect(flat(bar)).toMatchObject({ height: 52, paddingHorizontal: 8, gap: 10 });
      expect(within(bar).UNSAFE_getByType(AgentMascot).props).toMatchObject({
        id: "bot_research1", name: "Account research", category: "sales", size: 32,
      });
      const title = within(bar).getByRole("header", { name: "Account research" });
      expect(flat(title)).toMatchObject({ fontFamily: "Geist_600SemiBold", fontSize: 16, lineHeight: 22 });
      expect(flat(title).textAlign).toBeUndefined();
      // The name is the only text in the bar: no schedule line under it.
      expect(within(bar).getAllByText(/./)).toHaveLength(1);
    });

    it("goes back from a 44pt button with the 22pt back icon", () => {
      const { props } = renderScreen();

      const back = screen.getByRole("button", { name: "Back" });
      expect(flat(back)).toMatchObject({ width: 44, height: 44 });
      expect(within(back).UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 22 });
      fireEvent.press(back);

      expect(props.onBack).toHaveBeenCalledTimes(1);
    });

    it("opens the agent's details from a filled 44pt button with the 18pt info icon", () => {
      const { props } = renderScreen();

      const details = screen.getByRole("button", { name: "Agent details" });
      expect(flat(details)).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#FAF9F7" });
      expect(within(details).UNSAFE_getByType(Icon).props).toMatchObject({ icon: InfoIcon, size: 18 });
      fireEvent.press(details);

      expect(props.onOpenDetails).toHaveBeenCalledTimes(1);
    });

    it("has no side panel button and no New chat", () => {
      renderScreen();

      expect(screen.queryByRole("button", { name: "Open chats and projects" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    });
  });

  describe("composer", () => {
    it("invites a message to the agent by name", () => {
      renderScreen();

      expect(screen.getByPlaceholderText("Ask Account research…")).toBeTruthy();
    });

    it("has no model control and no microphone: attach on the left, send on the right", () => {
      renderScreen();

      expect(screen.UNSAFE_queryByType(ModelTrigger)).toBeNull();
      expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
      expect(screen.UNSAFE_queryAllByType(Icon).some((icon) => icon.props.icon === MicIcon)).toBe(false);
      const leading = screen.getByTestId("composer-toolbar-leading");
      expect(within(leading).getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(["Attach"]);
      expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    });

    it("sends what was typed", () => {
      const { props } = renderScreen({
        composer: { draft: "Who is next?", onChangeDraft: jest.fn(), canSend: true, onSend: jest.fn() },
      });

      fireEvent.press(screen.getByRole("button", { name: "Send message" }));

      expect(props.composer.onSend).toHaveBeenCalledTimes(1);
    });

    it("turns send into stop while a turn runs", () => {
      const onStop = jest.fn();
      renderScreen({
        composer: { draft: "", onChangeDraft: jest.fn(), canSend: false, onSend: jest.fn(), running: true, onStop },
      });

      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      fireEvent.press(screen.getByRole("button", { name: "Stop" }));

      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe("layout", () => {
    it("fills the display on the background colour, from under the status bar down to the home indicator", () => {
      renderScreen();

      const frame = screen.UNSAFE_getByType(KeyboardAvoidingView);
      expect(flat(frame)).toMatchObject({ flex: 1, backgroundColor: "#FFFEFC", paddingTop: 62 });
      // There is no tab bar under this screen: the composer keeps its own 10pt
      // above the home indicator's space, which is the last thing in the screen.
      expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(10);
      expect(flat(screen.getByTestId("agent-chat-bottom-inset")).height).toBe(34);
      const blocks = frame.props.children as unknown[];
      expect((blocks[blocks.length - 1] as { props: { testID?: string } }).props.testID).toBe("agent-chat-bottom-inset");
    });

    it("leaves the home indicator's space to a view of its own, as the keyboard view replaces its own bottom padding", () => {
      renderScreen();

      expect(flat(screen.UNSAFE_getByType(KeyboardAvoidingView)).paddingBottom).toBeUndefined();
    });

    it("makes room on iOS for the part of the keyboard above the home indicator's space, so nothing jumps when it opens", () => {
      Platform.OS = "ios";
      const view = renderScreen();
      const frame = () => screen.UNSAFE_getByType(KeyboardAvoidingView);
      expect(frame().props).toMatchObject({ behavior: "padding", keyboardVerticalOffset: -34 });

      mockKeyboardVisible = true;
      view.rerender(
        <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
          <AgentChatScreen {...view.props} />
        </SafeAreaInsetsContext.Provider>,
      );

      expect(flat(screen.getByTestId("agent-chat-bottom-inset")).height).toBe(34);
      expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
    });

    it("gives the space up on Android while the keyboard is open, where the window itself shrinks", () => {
      Platform.OS = "android";
      mockKeyboardVisible = true;
      renderScreen();

      expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBeUndefined();
      expect(flat(screen.getByTestId("agent-chat-bottom-inset")).height).toBe(0);
      expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
    });

    it("draws the chat's messages, and whatever the screen is told to draw for a request or under a reply", () => {
      const request = message({ id: "msg_request", role: "assistant", text: "" });
      renderScreen({
        messages: [request, reply, asked],
        renderRequest: (item) => (item.id === request.id ? <Text>Which folder?</Text> : null),
        renderResults: (item) => (item.id === reply.id ? <Text>Northwind · account brief</Text> : null),
      });

      expect(screen.getByText("Who am I meeting next?")).toBeTruthy();
      expect(screen.getByText("Brief ready for your call.")).toBeTruthy();
      expect(screen.getByText("Which folder?")).toBeTruthy();
      expect(screen.getByText("Northwind · account brief")).toBeTruthy();
    });

    it("draws what the agent is waiting for after the newest message", () => {
      renderScreen({ footer: <Text>Needs your approval</Text> });

      expect(screen.getByText("Needs your approval")).toBeTruthy();
      // The list is drawn from the bottom up, so what comes last is its header.
      const list = screen.UNSAFE_getByType(FlatList);
      expect(list.props.inverted).toBe(true);
      expect(list.props.ListHeaderComponent).toBeTruthy();
    });

    it("says in plain words under the top bar when something about the agent could not be read", () => {
      renderScreen({ notice: "Agent status could not be loaded. Try again." });

      const notice = screen.getByRole("alert");
      expect(notice.props.children).toBe("Agent status could not be loaded. Try again.");
      expect(flat(notice)).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#635F5F", textAlign: "center" });
    });

    it("shows no notice otherwise", () => {
      renderScreen();

      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("before the chat is there", () => {
    it("shows skeleton rows, the top bar and no composer while the chat is being found", () => {
      renderScreen({ state: "loading", messages: [], chatId: null });

      expect(screen.getAllByTestId("agent-chat-skeleton-row").length).toBeGreaterThan(0);
      expect(flat(screen.getByTestId("agent-chat-loading"))).toMatchObject({ flex: 1, paddingHorizontal: 20 });
      expect(screen.getByRole("header", { name: "Account research" })).toBeTruthy();
      expect(screen.queryByTestId("composer")).toBeNull();
    });

    it("says in generic words that the chat could not be opened, with a retry", () => {
      const { props } = renderScreen({ state: "failed", messages: [], chatId: null });

      expect(screen.getByRole("alert").props.children).toBe("This agent's chat could not be opened.");
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(screen.queryByTestId("agent-chat-skeleton-row")).toBeNull();
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      expect(props.onRetry).toHaveBeenCalledTimes(1);
      // The way out still works.
      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(props.onBack).toHaveBeenCalledTimes(1);
    });
  });
});
