import React from "react";
import { Pressable, View } from "react-native";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";

import { ActiveChatProvider } from "../components/chat/active-chat";
import { ActiveChatScreen } from "../components/chat/ActiveChatScreen";
import { CanonicalChatSessionProvider, useCanonicalChatSession } from "../lib/canonical-chat-session-context";
import { composerChoices } from "../lib/remembered-composer-choice";
import { createCanonicalChatFixture } from "../../../tests/contracts/fixtures/canonical-chat";

import { GPT, SONNET, catalogOf, codexInstance, matrixInstance, type Instance } from "./model-test-catalog";

const SCOPE = "user_fixture:fixture:primary";
const mockSend = jest.fn();
let mockDetails: Record<string, unknown> = {};

function withModes(instance: Instance, permissionModes: string[]): Instance {
  return { ...instance, supports: { ...instance.supports, permissionModes } };
}

// As the computer lists them: Codex runs turns in all four modes, Matrix AI's own route in Supervised only.
const mockCatalog = catalogOf(
  withModes(matrixInstance(), ["supervised"]),
  withModes(codexInstance([[GPT.model, "GPT-5.6-Sol"], ["gpt-5.6-mini", "GPT-5.6 Mini"]]),
    ["supervised", "auto_accept_edits", "auto", "full_access"]),
);

/** A chat whose one run, on Codex, ran in `permissionMode`. */
function chatThatRan(chatId: string, permissionMode: string) {
  const source = createCanonicalChatFixture("completed").snapshot;
  const run = { ...source.runs[0]!, chatId, selection: GPT, interactionMode: "default", permissionMode };
  return { record: { chat: { ...source.chat, id: chatId, currentSelection: GPT } },
    runs: [run], turns: [], activities: [], messages: [] };
}

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "user_fixture", getToken: async () => "session-token" }),
}));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
jest.mock("@/lib/use-session-token-warmup", () => ({ useSessionTokenWarmup: () => jest.fn() }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => jest.fn() }));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({ useCanonicalChatDetail: (chatId: string | null) => ({
  detail: chatId ? mockDetails[chatId] : null,
  computer: { handle: "fixture", runtimeSlot: "primary", gatewayPath: "/vm/fixture" },
  refresh: jest.fn(), isError: false, reload: jest.fn(),
}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: [], computer: undefined }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({ useChatProviderCatalog: () => ({
  catalog: mockCatalog, isPending: false, isFetching: false,
}) }));
jest.mock("@/lib/queries/use-matrix-credit-balance", () => ({
  useMatrixCreditBalance: () => ({ label: null, isPending: false, isError: false }),
}));
jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: null, isError: false }) }));
jest.mock("@/lib/queries/use-mark-chat-read", () => ({ useMarkChatRead: jest.fn() }));
jest.mock("@/lib/queries/use-send-chat-message", () => ({ useSendChatMessage: () => ({ mutate: mockSend, isPending: false }) }));
jest.mock("@/components/agents/chat-draft-request", () => ({ useChatDraftRequest: () => null, consumeChatDraftRequest: jest.fn() }));
jest.mock("@/components/chat/use-chat-thread", () => ({ useChatThread: () => ({ messages: [], running: false, onStop: jest.fn() }) }));
jest.mock("@/components/chat/composer-add", () => ({ composerAddProps: () => ({}) }));
// As the native sheet does while it slides away, this one keeps its content
// when it is not presented.
jest.mock("@expo/ui", () => {
  const { View: SheetView } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: ({ children }: { children: React.ReactNode }) => <SheetView testID="expo-bottom-sheet">{children}</SheetView>,
    RNHostView: ({ children }: { children: React.ReactNode }) => children,
  };
});
// Keep the real session, chat state, composer and model picker. The view is a
// small adapter that shows the composer's input, Send and the model control.
jest.mock("@/components/chat/ChatScreenView", () => {
  const { View: Row, TextInput, Pressable: Button } = jest.requireActual<typeof import("react-native")>("react-native");
  return { ChatScreenView: ({ composer }: import("../components/chat/ChatScreenView").ChatScreenViewProps) => (
    <Row>
      <TextInput accessibilityLabel="Test message" value={composer.draft} onChangeText={composer.onChangeDraft} />
      <Button accessibilityRole="button" accessibilityLabel="Send" disabled={!composer.canSend} onPress={composer.onSend} />
      {composer.modelControl}
    </Row>
  ) };
});

/** Offers the session's ways of changing the chat on screen. */
function SessionControls() {
  const session = useCanonicalChatSession();
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel="Open chat one" onPress={() => session.selectChat("chat_one")} />
      <Pressable accessibilityRole="button" accessibilityLabel="Open chat two" onPress={() => session.selectChat("chat_two")} />
      <Pressable accessibilityRole="button" accessibilityLabel="New chat" onPress={() => session.startDraftChat()} />
    </View>
  );
}

function renderChatScreen() {
  render(
    <CanonicalChatSessionProvider>
      <ActiveChatProvider>
        <SessionControls />
        <ActiveChatScreen onBack={() => undefined} />
      </ActiveChatProvider>
    </CanonicalChatSessionProvider>,
  );
}

const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const trigger = () => screen.getByRole("button", { name: "Model" });
const sheetModes = () => within(screen.getByTestId("model-sheet-permission-mode"));
/** The mode the sheet marks as the one the next message is sent with. */
function markedMode(): string | undefined {
  fireEvent.press(trigger());
  return sheetModes().getAllByRole("button").find((chip) => chip.props.accessibilityState.selected)?.props.accessibilityLabel;
}

function send(text: string) {
  fireEvent.changeText(screen.getByLabelText("Test message"), text);
  press("Send");
}

function chooseMode(label: string) {
  fireEvent.press(trigger());
  fireEvent.press(sheetModes().getByRole("button", { name: label }));
}

function chooseModel(engine: string, model: string) {
  fireEvent.press(trigger());
  fireEvent.press(within(screen.getByTestId("model-sheet-engines")).getByRole("button", { name: engine }));
  fireEvent.press(within(screen.getByTestId("model-sheet-models")).getByRole("button", { name: model }));
}

beforeEach(async () => {
  mockDetails = { chat_one: chatThatRan("chat_one", "auto"), chat_two: chatThatRan("chat_two", "supervised") };
  await composerChoices.forget();
  await composerChoices.load();
});
afterEach(() => {
  cleanup();
  mockSend.mockReset();
});

describe("the permission mode of an open chat", () => {
  it("stays the one the chat last ran with until another is chosen, which goes with the next message", () => {
    renderChatScreen();
    press("Open chat one");

    send("Run the tests");
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "chat_one", selection: GPT, permissionMode: "auto",
    }), expect.anything());

    chooseMode("Full Access");
    send("Run them again");
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "chat_one", selection: GPT, permissionMode: "full_access",
    }), expect.anything());
    expect(markedMode()).toBe("Full Access");
  });

  it("stays when another model is chosen for the chat", () => {
    renderChatScreen();
    press("Open chat one");

    chooseModel("Codex", "GPT-5.6 Mini, Codex");
    send("Try the smaller model");

    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "chat_one", selection: { ...GPT, model: "gpt-5.6-mini" }, permissionMode: "auto",
    }), expect.anything());
  });

  it("is chosen for that chat only: another chat opened keeps its own", () => {
    renderChatScreen();
    press("Open chat one");
    chooseMode("Full Access");

    press("Open chat two");
    send("What changed?");

    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "chat_two", permissionMode: "supervised",
    }), expect.anything());
  });

  it("is remembered on this phone for the next new chat", () => {
    act(() => composerChoices.remember(SCOPE, { selection: GPT }));
    renderChatScreen();
    press("Open chat one");
    chooseMode("Full Access");

    expect(composerChoices.choice(SCOPE)).toEqual({ selection: GPT, permissionMode: "full_access" });

    press("New chat");
    send("Start something new");
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: null, selection: GPT, permissionMode: "full_access",
    }), expect.anything());
  });
});

describe("the permission mode of a new chat", () => {
  it("starts as the one last chosen on this phone", () => {
    act(() => composerChoices.remember(SCOPE, { selection: GPT, permissionMode: "auto_accept_edits" }));
    renderChatScreen();

    send("Fix the lint errors");

    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: null, selection: GPT, interactionMode: "default", permissionMode: "auto_accept_edits",
    }), expect.anything());
  });

  it("falls back to Supervised on an engine without the chosen mode, and comes back with one that runs it", () => {
    act(() => composerChoices.remember(SCOPE, { selection: GPT, permissionMode: "full_access" }));
    renderChatScreen();

    chooseModel("Matrix AI", "Sonnet 5, Matrix AI");
    fireEvent.press(trigger());
    expect(screen.queryByTestId("model-sheet-permission-mode")).toBeNull();
    send("Summarise the plan");
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      selection: SONNET, permissionMode: "supervised",
    }), expect.anything());

    chooseModel("Codex", "GPT-5.6-Sol, Codex");
    expect(markedMode()).toBe("Full Access");
    expect(composerChoices.choice(SCOPE)?.permissionMode).toBe("full_access");
  });
});
