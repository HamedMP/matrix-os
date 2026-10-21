import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import ChatScreen from "../app/(drawer)/(tabs)/(chats)/index";
import { ActiveChatProvider } from "../components/chat/active-chat";
import { ActiveChatScreen } from "../components/chat/ActiveChatScreen";
import { createCanonicalChatFixture } from "../../../tests/contracts/fixtures/canonical-chat";

const mockSend = jest.fn();
let mockActiveChatId = "chat_one";
const fixture = createCanonicalChatFixture("completed");
let mockDetail = detail("chat_one", "plan", "full_access");
const mockCatalog = fixture.providerCatalog;

function detail(chatId: string, interactionMode: string, permissionMode: string) {
  const source = createCanonicalChatFixture("completed").snapshot;
  const run = { ...source.runs[0]!, chatId, interactionMode, permissionMode };
  return { record: { chat: { ...source.chat, id: chatId, currentSelection: run.selection } },
    runs: [run], turns: [], activities: [], messages: [] };
}

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isSignedIn: true, userId: "user_fixture" }) }));
jest.mock("@/lib/use-session-token-warmup", () => ({ useSessionTokenWarmup: () => jest.fn() }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => jest.fn() }));
jest.mock("@/lib/canonical-chat-session-context", () => ({ useCanonicalChatSession: () => ({
  activeChatId: mockActiveChatId, startDraftChat: jest.fn(), draftChatRequests: 0,
  selectionOverride: null, setSelectionOverride: jest.fn(), selectedProjectId: null,
}) }));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({ useCanonicalChatDetail: () => ({
  detail: mockDetail, computer: { handle: "fixture", runtimeSlot: "primary", gatewayPath: "/vm/fixture" },
  refresh: jest.fn(), isError: false, reload: jest.fn(),
}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: [] }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({ useChatProviderCatalog: () => ({
  catalog: mockCatalog, isPending: false, isFetching: false,
}) }));
jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: null, isError: false }) }));
jest.mock("@/lib/queries/use-send-chat-message", () => ({ useSendChatMessage: () => ({ mutate: mockSend, isPending: false }) }));
jest.mock("@/components/agents/chat-draft-request", () => ({ useChatDraftRequest: () => null, consumeChatDraftRequest: jest.fn() }));
jest.mock("@/components/chat/use-chat-thread", () => ({ useChatThread: () => ({ messages: [], running: false, onStop: jest.fn() }) }));
jest.mock("@/components/chat/composer-add", () => ({ composerAddProps: () => ({}) }));
jest.mock("@/components/ModelPicker", () => ({ ModelPicker: () => null }));
// Keep the actual screen orchestration, shared derivation, composer and outgoing
// mutation. The view is a small input adapter so this test isolates that wiring.
jest.mock("@/components/chat/ChatScreenView", () => {
  const React = require("react");
  const { View, TextInput, Pressable } = require("react-native");
  return { ChatScreenView: ({ composer }: import("../components/chat/ChatScreenView").ChatScreenViewProps) => (
    <View>
      <TextInput accessibilityLabel="Test message" value={composer.draft} onChangeText={composer.onChangeDraft} />
      <Pressable accessibilityRole="button" accessibilityLabel="Send follow-up" disabled={!composer.canSend} onPress={composer.onSend} />
    </View>
  ) };
});

beforeEach(() => {
  mockActiveChatId = "chat_one";
  mockDetail = detail("chat_one", "plan", "full_access");
});
afterEach(() => { cleanup(); mockSend.mockReset(); });

it.each(["Chats tab", "project chat"])("%s sends accepted modes and switches to the second Chat's own modes", (surface) => {
  const subject = () => <ActiveChatProvider>{surface === "Chats tab"
    ? <ChatScreen /> : <ActiveChatScreen onBack={() => undefined} />}</ActiveChatProvider>;
  const view = render(subject());
  fireEvent.changeText(screen.getByLabelText("Test message"), "Open example.com");
  fireEvent.press(screen.getByRole("button", { name: "Send follow-up" }));
  expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
    chatId: "chat_one", interactionMode: "plan", permissionMode: "full_access",
    selection: mockDetail.record.chat.currentSelection,
  }), expect.anything());

  mockActiveChatId = "chat_two";
  mockDetail = detail("chat_two", "default", "supervised");
  view.rerender(subject());
  fireEvent.changeText(screen.getByLabelText("Test message"), "Tell me the title");
  fireEvent.press(screen.getByRole("button", { name: "Send follow-up" }));
  expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
    chatId: "chat_two", interactionMode: "default", permissionMode: "supervised",
  }), expect.anything());
});

it("does not reuse accepted controls while the loaded detail belongs to the previous Chat", () => {
  mockActiveChatId = "chat_two";
  render(<ActiveChatProvider><ChatScreen /></ActiveChatProvider>);
  fireEvent.changeText(screen.getByLabelText("Test message"), "Read the next page");
  fireEvent.press(screen.getByRole("button", { name: "Send follow-up" }));
  expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
    chatId: "chat_two", interactionMode: "default", permissionMode: "supervised",
  }), expect.anything());
});
