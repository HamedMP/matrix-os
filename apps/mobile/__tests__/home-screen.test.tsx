jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: mockBotSnapshot, isError: false }) }));
jest.mock("@/lib/queries/use-bot-recipes", () => ({ useBotRecipes: () => ({ recipes: [], isPending: false, isError: false }) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ invalidate: jest.fn() }) }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
import type { ReactNode } from "react";

const mockSendMessage = jest.fn();
let mockBotSnapshot: unknown = null;
let mockActiveChatId: string | null = null;
let mockDetail: unknown;
let mockProviderCatalog: unknown;

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true }),
  useUser: () => ({
    isLoaded: true,
    user: { firstName: "Shubham", fullName: "Shubham Zanwar", username: "shubham" },
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
    setSelectedProjectId: jest.fn(),
    bindDraftChatId: jest.fn(),
  }),
}));

jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({ detail: mockDetail }),
}));

jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockProviderCatalog }),
}));

jest.mock("@/lib/queries/use-projects", () => ({
  useProjects: () => ({ projects: [], isPending: false, isError: false }),
}));

jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: false }),
}));

jest.mock("@expo/ui", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Host: ({ children }: { children: ReactNode }) => React.createElement(View, null, children),
    Picker: () => null,
  };
});

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, StyleSheet as NativeStyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";

import ChatScreen from "../app/(drawer)/index";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => jest.runOnlyPendingTimers()); cleanup(); jest.useRealTimers(); });

describe("drawer home screen", () => {
  it("expands the exact tool command and bounded result", () => {
    mockActiveChatId = "chat_tools";
    mockDetail = { record: { chat: { id: mockActiveChatId } }, turns: [],
      runs: [{ id: "run_tools", turnId: "cturn_tools", status: "running", selection: { model: "test" }, createdAt: "2026-09-20T00:00:00.000Z" }],
      messages: [], activities: [
        { id: "activity_tools", runId: "run_tools", type: "agent.activity", activityId: "tool_tests", kind: "command", label: "Run command", status: "running", preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo" },
        { id: "activity_output", runId: "run_tools", type: "tool.output", toolCallId: "tool_tests", text: "12 tests passed", truncated: false },
      ] };
    render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Run command: bun run test" }));
    expect(screen.getByText(/12 tests passed/)).toBeTruthy();
  });

  afterEach(() => { mockBotSnapshot = null; mockSendMessage.mockClear(); mockActiveChatId = null; mockDetail = undefined; jest.restoreAllMocks(); });
  it("copies the displayed Native Mobile conversation ID by long-pressing its content", () => {
    mockActiveChatId = "chat_native_content";
    mockDetail = { record: { chat: { id: mockActiveChatId } }, runs: [], turns: [], activities: [],
      messages: [{ id: "msg_native_copy", chatId: mockActiveChatId, role: "user", state: "committed", seq: 1,
        parts: [{ type: "text", text: "Inspect native failure" }], createdAt: "2026-09-09T00:00:00.000Z" }] };
    const alert = jest.spyOn(Alert, "alert");
    render(<ChatScreen />);
    fireEvent(screen.getByText("Inspect native failure"), "longPress");
    const action = alert.mock.calls[0]?.[2]?.find((button) => button.text === "Copy chat ID");
    expect(action).toBeDefined();
    action!.onPress?.();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_content");
  });

  it("uses the Matrix rabbit artwork for its empty-state mark", () => {
    render(<ChatScreen />);

    expect(screen.getByText("Welcome back Shubham")).toBeTruthy();
    const rabbitStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-mark").props.style);
    expect(rabbitStyle).toMatchObject({ width: 68, height: 68 });
    const containerStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-container").props.style);
    expect(containerStyle).toMatchObject({ width: 68, height: 68 });
  });
});

it("sends an owner-verified Native bot Chat with its private route while the general model catalog is unavailable", () => {
  mockActiveChatId = "chat_bot";
  mockDetail = { record: { chat: { id: mockActiveChatId, revision: 3 } }, runs: [], turns: [], activities: [], messages: [] };
  mockBotSnapshot = { kind: "recipe", recipeRef: { recipeId: "writer", version: "1" }, agentId: "bot_abcdefgh", name: "Writer", revision: 2,
    selection: { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" }, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<ChatScreen />);
  const input = screen.getByPlaceholderText("Message Matrix");
  fireEvent.changeText(input, "Write a brief");
  fireEvent(input, "focus");
  fireEvent.press(screen.getByRole("button", { name: "Send message" }));
  expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_bot", baseRevision: 3,
    selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" }), expect.anything());
});

it("Native Mobile custom Bot submits its retained executor and exact revision after explicit consent", () => {
 const { createCanonicalProviderCatalogFixture } = require("../../../tests/contracts/fixtures/canonical-chat");
 const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0];
 catalog.instances = [{ ...base, id: "hermes_custom", driverKind: "hermes", displayName: "Hermes", models: [{ ...base.models[0], id: "retained" }], supports: { ...base.supports, permissionModes: ["full_access"] } }]; mockProviderCatalog = catalog;
 mockActiveChatId = "chat_custom"; mockDetail = { record: { chat: { id: mockActiveChatId, revision: 3 } }, runs: [], turns: [], activities: [], messages: [] };
 mockBotSnapshot = { kind: "custom", agentId: "bot_custom01", name: "My custom Bot", revision: 2, instructions: "Read only", selection: { instanceId: "hermes_custom", model: "retained" }, interactions: [], tasks: [], authority: null };
 mockSendMessage.mockClear(); render(<ChatScreen/>);
 const input = screen.getByPlaceholderText("Message Matrix"); fireEvent.changeText(input,"Read only");
 expect(screen.getByRole("button",{name:"Send message"}).props.accessibilityState.disabled).toBe(true);
 fireEvent.press(screen.getByRole("checkbox")); fireEvent.press(screen.getByRole("button",{name:"Send message"}));
 expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ selection:{instanceId:"hermes_custom",model:"retained"},permissionMode:"full_access",botResource:{kind:"agent",id:"bot_custom01",label:"My custom Bot",revision:"2"} }),expect.anything());
 act(() => mockSendMessage.mock.calls[0][1].onSuccess());
 expect(screen.getByRole("checkbox").props.accessibilityState.checked).toBe(false);
 fireEvent.changeText(input, "Read only");
 expect(screen.getByRole("button", {name:"Send message"}).props.accessibilityState.disabled).toBe(true);
 mockProviderCatalog = undefined;
});

it.each(["matrix_pi", "opencode"])("Native Mobile custom %s Bot sends Supervised without offering unsupported Full access", driverKind => {
  const { createCanonicalProviderCatalogFixture } = require("../../../tests/contracts/fixtures/canonical-chat");
  const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0];
  catalog.instances = [{ ...base, id: "custom_supervised", driverKind, models: [{ ...base.models[0], id: "retained" }],
    supports: { ...base.supports, permissionModes: ["supervised"] } }];
  mockProviderCatalog = catalog;
  mockActiveChatId = "chat_supervised";
  mockDetail = { record: { chat: { id: mockActiveChatId, revision: 3 } }, runs: [], turns: [], activities: [], messages: [] };
  mockBotSnapshot = { kind: "custom", agentId: "bot_supervised", name: "Saved Bot", revision: 2,
    selection: { instanceId: "custom_supervised", model: "retained" }, interactions: [], tasks: [], authority: null };
  mockSendMessage.mockClear();
  render(<ChatScreen />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.changeText(screen.getByPlaceholderText("Message Matrix"), "Read only");
  fireEvent.press(screen.getByRole("button", { name: "Send message" }));
  expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
    selection: { instanceId: "custom_supervised", model: "retained" }, permissionMode: "supervised",
  }), expect.anything());
  mockProviderCatalog = undefined;
});
