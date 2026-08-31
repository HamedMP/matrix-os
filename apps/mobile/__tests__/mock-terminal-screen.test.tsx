import type { ReactNode } from "react";

const mockPush = jest.fn();
const mockUseComputerTerminals = jest.fn();
const mockCreateSession = jest.fn();
const mockRenameSession = jest.fn();
const mockDeleteSession = jest.fn();
const mockRefreshTerminals = jest.fn();

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Swipeable: React.forwardRef(function MockSwipeable(
      { children, renderRightActions }: { children: React.ReactNode; renderRightActions?: () => React.ReactNode },
      _ref: React.ForwardedRef<unknown>,
    ) {
      return <View>{children}{renderRightActions?.()}</View>;
    }),
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/lib/queries/use-computer-terminals", () => ({
  useComputerTerminals: () => mockUseComputerTerminals(),
}));

jest.mock("@expo/ui", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: ({ children, isPresented }: { children: ReactNode; isPresented: boolean }) => (
      isPresented ? <View testID="terminal-manage-sheet">{children}</View> : null
    ),
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import TerminalScreen from "../app/(drawer)/terminal";
import { mockColors } from "@/components/mock-shell/theme";
import { palette } from "@/lib/theme";

describe("drawer terminal screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerTerminals.mockReturnValue({
      sessions: [
        { name: "main", status: "active", visualStatus: "running", cwd: "projects/matrix-os", branch: "main", agent: "claude" },
        { name: "review-pr-42", status: "active", visualStatus: "waiting", subtitle: "Waiting for approval", agent: "codex" },
        { name: "notes", status: "active", visualStatus: "idle", cwd: "~" },
      ],
      isPending: false,
      isError: false,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
      createSession: mockCreateSession,
      refresh: mockRefreshTerminals,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds the native refresh control open until terminals finish refreshing", async () => {
    let resolveRefresh: (() => void) | undefined;
    mockRefreshTerminals.mockReturnValue(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    render(<TerminalScreen />);

    React.act(() => screen.getByTestId("mock-page-refresh-control").props.onRefresh());

    expect(mockRefreshTerminals).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-page-refresh-control").props.refreshing).toBe(true);

    await React.act(async () => resolveRefresh?.());
    expect(screen.getByTestId("mock-page-refresh-control").props.refreshing).toBe(false);
  });

  it("renders VPS sessions and uses semantic status colors", () => {
    render(<TerminalScreen />);

    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("review-pr-42")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
    expect(screen.queryByText("solar-vale")).toBeNull();
    expect(NativeStyleSheet.flatten(screen.getByTestId("list-row-icon-main").props.style).backgroundColor)
      .toBe(palette.green[100]);
    expect(NativeStyleSheet.flatten(screen.getByTestId("list-row-icon-review-pr-42").props.style).backgroundColor)
      .toBe(palette.gold[100]);
    expect(NativeStyleSheet.flatten(screen.getByTestId("list-row-icon-notes").props.style).backgroundColor)
      .toBe(palette.neutral[200]);
  });

  it("shows the desktop-style agent logo beside the session path", () => {
    render(<TerminalScreen />);

    expect(screen.getByTestId("terminal-session-agent-logo-claude")).toBeTruthy();
    expect(screen.getByTestId("terminal-session-agent-logo-image-claude")).toBeTruthy();
    expect(screen.getAllByTestId("terminal-session-agent-separator")).toHaveLength(2);
    expect(screen.getByTestId("terminal-session-agent-logo-codex")).toBeTruthy();
    expect(screen.queryByTestId("terminal-session-agent-logo-notes")).toBeNull();
  });

  it("shows three full-size terminal row skeletons while sessions load", () => {
    mockUseComputerTerminals.mockReturnValue({
      sessions: [],
      isPending: true,
      isError: false,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
    });

    render(<TerminalScreen />);

    const skeletons = screen.getAllByTestId("terminal-row-skeleton");
    expect(skeletons).toHaveLength(3);
    expect(NativeStyleSheet.flatten(skeletons[0].props.style)).toMatchObject({
      height: 66,
      backgroundColor: mockColors.soft,
    });
    expect(screen.getAllByTestId("terminal-skeleton-shimmer")).toHaveLength(3);
  });

  it("filters sessions by a case-insensitive name substring only", () => {
    render(<TerminalScreen />);

    fireEvent.changeText(screen.getByLabelText("Search sessions"), "REVIEW");

    expect(screen.getByText("review-pr-42")).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByText("notes")).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Search sessions"), "approval");

    expect(screen.queryByText("review-pr-42")).toBeNull();
  });

  it("renames a swiped terminal after editing its name in a popup", async () => {
    mockRenameSession.mockResolvedValue(undefined);
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Rename main terminal"));
    fireEvent.changeText(screen.getByLabelText("Terminal session name"), "renamed-session");
    fireEvent.press(screen.getByLabelText("Save terminal name"));

    expect(mockRenameSession).toHaveBeenCalledWith("main", "renamed-session");
  });

  it("requires popup confirmation before deleting a swiped terminal", () => {
    mockDeleteSession.mockResolvedValue(undefined);
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Delete main terminal"));

    expect(screen.getByText("Delete terminal session?")).toBeTruthy();
    expect(mockDeleteSession).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Confirm delete terminal"));

    expect(mockDeleteSession).toHaveBeenCalledWith("main");
  });

  it("stretches square swipe actions to the terminal row height without a fixed size", () => {
    render(<TerminalScreen />);

    const style = NativeStyleSheet.flatten(screen.getByLabelText("Rename main terminal").props.style);

    expect(style.height).toBeUndefined();
    expect(style.width).toBeUndefined();
    expect(style.alignSelf).toBe("stretch");
    expect(style.aspectRatio).toBe(1);
  });

  it("creates a session from the manage sheet and opens the new terminal", async () => {
    jest.useFakeTimers();
    let resolveCreate: ((name: string) => void) | undefined;
    mockCreateSession.mockImplementation(() => new Promise<string>((resolve) => {
      resolveCreate = resolve;
    }));
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Manage terminals"));
    expect(screen.getByText("Manage terminals")).toBeTruthy();
    expect(screen.getByTestId("new-terminal-session-chevron")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("New session"));
    expect(screen.queryByTestId("new-terminal-session-chevron")).toBeNull();
    expect(screen.getByTestId("new-terminal-session-loading")).toBeTruthy();

    await React.act(async () => resolveCreate?.("swift-falcon"));

    expect(screen.queryByTestId("terminal-manage-sheet")).toBeNull();
    await React.act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/terminal-session/[session]",
      params: { session: "swift-falcon" },
    });
  });
});
