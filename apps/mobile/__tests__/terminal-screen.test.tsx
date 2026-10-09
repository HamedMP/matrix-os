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
import { RefreshControl, StyleSheet as NativeStyleSheet } from "react-native";

import TerminalScreen from "../app/(drawer)/(tabs)/terminal";
import { appColors, palette } from "@/lib/theme-v2";

const WORKSPACE = "tws_00000000000000000000000000000001";

function terminalSession(tabSuffix: string, overrides: Record<string, unknown>) {
  const tabId = `tt_${tabSuffix.padStart(32, "0")}`;
  return {
    id: `${WORKSPACE}:${tabId}`,
    workspaceId: WORKSPACE,
    tabId,
    revision: 3,
    cwd: "",
    status: "active",
    visualStatus: "running",
    ...overrides,
  };
}

const mainSession = terminalSession("a", {
  name: "main",
  cwd: "projects/matrix-os",
  branch: "main",
  agent: "claude",
});
const reviewSession = terminalSession("b", {
  name: "review-pr-42",
  status: "degraded",
  visualStatus: "waiting",
  cwd: "projects/approval-flow",
  agent: "codex",
});
const notesSession = terminalSession("c", { name: "notes", visualStatus: "idle" });

describe("drawer terminal screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerTerminals.mockReturnValue({
      sessions: [mainSession, reviewSession, notesSession],
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

    React.act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    expect(mockRefreshTerminals).toHaveBeenCalledTimes(1);
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);

    await React.act(async () => resolveRefresh?.());
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
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
      backgroundColor: appColors.light.soft,
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

    expect(mockRenameSession).toHaveBeenCalledWith(mainSession, "renamed-session");
  });

  it("accepts a display name with spaces and capitals", async () => {
    mockRenameSession.mockResolvedValue(undefined);
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Rename main terminal"));
    fireEvent.changeText(screen.getByLabelText("Terminal session name"), "  Deploy logs  ");
    fireEvent.press(screen.getByLabelText("Save terminal name"));

    expect(mockRenameSession).toHaveBeenCalledWith(mainSession, "Deploy logs");
  });

  it("explains the name rule instead of sending a blank name", () => {
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Rename main terminal"));
    fireEvent.changeText(screen.getByLabelText("Terminal session name"), "   ");
    fireEvent.press(screen.getByLabelText("Save terminal name"));

    expect(mockRenameSession).not.toHaveBeenCalled();
    expect(screen.getAllByText("Use a name between 1 and 120 characters.")).toHaveLength(2);
  });

  it("keeps the rename popup open with an error when the computer refuses it", async () => {
    mockRenameSession.mockRejectedValue(new Error("Could not rename terminal. Try again."));
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Rename main terminal"));
    fireEvent.changeText(screen.getByLabelText("Terminal session name"), "renamed-session");
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("Save terminal name"));
    });

    expect(screen.getByText("Could not rename terminal. Try again.")).toBeTruthy();
    expect(screen.getByLabelText("Terminal session name")).toBeTruthy();
  });

  it("retries a refused rename with the revision the reloaded list shows", async () => {
    mockRenameSession.mockRejectedValueOnce(new Error("Could not rename terminal. Try again."));
    mockRenameSession.mockResolvedValueOnce(undefined);
    const rendered = render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Rename main terminal"));
    fireEvent.changeText(screen.getByLabelText("Terminal session name"), "renamed-session");
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("Save terminal name"));
    });
    expect(mockRenameSession).toHaveBeenLastCalledWith(mainSession, "renamed-session");

    // The refused rename reloaded the list: the tab is now at a newer revision.
    const reloaded = { ...mainSession, revision: 7 };
    mockUseComputerTerminals.mockReturnValue({
      sessions: [reloaded, reviewSession, notesSession],
      isPending: false,
      isError: false,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
      createSession: mockCreateSession,
      refresh: mockRefreshTerminals,
    });
    rendered.rerender(<TerminalScreen />);
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("Save terminal name"));
    });

    expect(mockRenameSession).toHaveBeenLastCalledWith(reloaded, "renamed-session");
    expect(screen.queryByLabelText("Terminal session name")).toBeNull();
  });

  it("requires popup confirmation before deleting a swiped terminal", () => {
    mockDeleteSession.mockResolvedValue(undefined);
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Delete main terminal"));

    expect(screen.getByText("Delete terminal session?")).toBeTruthy();
    expect(mockDeleteSession).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Confirm delete terminal"));

    expect(mockDeleteSession).toHaveBeenCalledWith(mainSession);
  });

  it("keeps the delete popup open with an error when the computer refuses it", async () => {
    mockDeleteSession.mockRejectedValue(new Error("Could not delete terminal. Try again."));
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Delete main terminal"));
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("Confirm delete terminal"));
    });

    expect(screen.getByText("Could not delete terminal. Try again.")).toBeTruthy();
    expect(screen.getByText("Delete terminal session?")).toBeTruthy();
  });

  it("opens a terminal by its workspace tab reference", () => {
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Open main terminal"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/terminal-session/[session]",
      params: { session: mainSession.id },
    });
  });

  it("lists two terminals that share a display name", () => {
    mockUseComputerTerminals.mockReturnValue({
      sessions: [
        terminalSession("d", { name: "Shell" }),
        terminalSession("e", { name: "Shell", cwd: "projects" }),
      ],
      isPending: false,
      isError: false,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
      createSession: mockCreateSession,
      refresh: mockRefreshTerminals,
    });
    render(<TerminalScreen />);

    expect(screen.getAllByText("Shell")).toHaveLength(2);
    expect(screen.getByText("~")).toBeTruthy();
    expect(screen.getByText("~/projects")).toBeTruthy();
  });

  it("groups exited terminals under closed sessions", () => {
    mockUseComputerTerminals.mockReturnValue({
      sessions: [mainSession, terminalSession("f", { name: "old-build", status: "exited", visualStatus: "idle" })],
      isPending: false,
      isError: false,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
      createSession: mockCreateSession,
      refresh: mockRefreshTerminals,
    });
    render(<TerminalScreen />);

    expect(screen.getByText("CLOSED SESSIONS")).toBeTruthy();
    expect(screen.getByText("old-build")).toBeTruthy();
  });

  it("says terminals are unavailable when the list could not be loaded", () => {
    mockUseComputerTerminals.mockReturnValue({
      sessions: [],
      isPending: false,
      isError: true,
      renameSession: mockRenameSession,
      deleteSession: mockDeleteSession,
      createSession: mockCreateSession,
      refresh: mockRefreshTerminals,
    });
    render(<TerminalScreen />);

    expect(screen.getByText("Terminals unavailable. Try again.")).toBeTruthy();
    expect(screen.queryByText("No active terminal sessions.")).toBeNull();
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

    await React.act(async () => resolveCreate?.(`${WORKSPACE}:tt_0000000000000000000000000000000f`));

    expect(screen.queryByTestId("terminal-manage-sheet")).toBeNull();
    await React.act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/terminal-session/[session]",
      params: { session: `${WORKSPACE}:tt_0000000000000000000000000000000f` },
    });
  });

  it("keeps the manage sheet open with an error when a session could not be created", async () => {
    mockCreateSession.mockRejectedValue(new Error("Could not create terminal. Try again."));
    render(<TerminalScreen />);

    fireEvent.press(screen.getByLabelText("Manage terminals"));
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("New session"));
    });

    expect(screen.getByText("Could not create terminal. Try again.")).toBeTruthy();
    expect(screen.getByTestId("terminal-manage-sheet")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
