jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: null, isError: false }) }));
jest.mock("@/lib/queries/use-bot-recipes", () => ({ useBotRecipes: () => ({ recipes: [], isPending: false, isError: false }) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ invalidate: jest.fn() }) }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
import type { ReactNode } from "react";

const mockSendMessage = jest.fn();
let mockCatalogState: Record<string, unknown> = {};

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "user_a" }),
  useUser: () => ({ isLoaded: true, user: { firstName: "Amin" } }),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: null,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
    setSelectedProjectId: jest.fn(),
    bindDraftChatId: jest.fn(),
  }),
}));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({ detail: undefined }),
}));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => mockCatalogState,
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

import ChatScreen from "../app/(drawer)/index";

const catalog = { instances: [{
  id: "codex_default", driverKind: "codex", availability: "available", options: [],
  defaultSelection: { instanceId: "codex_default", model: "gpt-test" },
  models: [{ id: "gpt-test", displayName: "GPT Test", availability: "available" }],
  supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
}] };

function typeAndSend(text: string) {
  fireEvent.changeText(screen.getByPlaceholderText("Message Matrix"), text);
  fireEvent.press(screen.getByRole("button", { name: "Send message" }));
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  mockSendMessage.mockClear();
});

describe("sending while the model catalog is fetched", () => {
  it("sends with the models already on hand while they are being re-checked", () => {
    mockCatalogState = { catalog, isPending: false, isFetching: true };
    render(<ChatScreen />);

    typeAndSend("hi");

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: null, text: "hi", selection: { instanceId: "codex_default", model: "gpt-test" },
      interactionMode: "default", permissionMode: "supervised",
    }), expect.anything());
  });

  it("holds a send back until there is a catalog to choose a model from", () => {
    mockCatalogState = { catalog: null, isPending: true, isFetching: true };
    render(<ChatScreen />);

    typeAndSend("hi");

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("shows the picker as checking while the catalog on hand is re-checked", () => {
    mockCatalogState = { catalog, isPending: false, isFetching: true };
    render(<ChatScreen />);
    fireEvent(screen.getByPlaceholderText("Message Matrix"), "focus");

    expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
  });
});
