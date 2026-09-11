import type { ReactNode } from "react";

const mockSendMessage = jest.fn();
let mockActiveChatId: string | null = null;
let mockDetail: unknown;

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
  useChatProviderCatalog: () => ({ catalog: undefined }),
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
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, StyleSheet as NativeStyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";

import ChatScreen from "../app/(drawer)/index";

describe("drawer home screen", () => {
  afterEach(() => { mockActiveChatId = null; mockDetail = undefined; jest.restoreAllMocks(); });
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
