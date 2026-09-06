import type { ReactNode } from "react";

const mockSendMessage = jest.fn();

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
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import ChatScreen from "../app/(drawer)/index";

describe("drawer home screen", () => {
  it("uses the Matrix rabbit artwork for its empty-state mark", () => {
    render(<ChatScreen />);

    expect(screen.getByText("Welcome back Shubham")).toBeTruthy();
    const rabbitStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-mark").props.style);
    expect(rabbitStyle).toMatchObject({ width: 68, height: 68 });
    const containerStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-container").props.style);
    expect(containerStyle).toMatchObject({ width: 68, height: 68 });
  });
});
