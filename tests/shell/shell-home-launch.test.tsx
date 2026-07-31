// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mobileViewport = false;
const desktopProps = vi.fn();
const mobileProps = vi.fn();

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "user-test" }),
}));

vi.mock("../../shell/src/hooks/useTheme.js", () => ({ useTheme: vi.fn() }));
vi.mock("../../shell/src/hooks/useDesktopConfig.js", () => ({ useDesktopConfig: vi.fn() }));
vi.mock("../../shell/src/hooks/useChatState.js", () => ({
  useChatState: () => ({ newChat: vi.fn() }),
}));
vi.mock("../../shell/src/hooks/useGlobalShortcuts.js", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("../../shell/src/hooks/useMobileViewport.js", () => ({
  useMobileViewport: () => mobileViewport,
}));
vi.mock("../../shell/src/stores/commands.js", () => ({
  useCommandStore: (selector: (state: { register: () => void; unregister: () => void }) => unknown) =>
    selector({ register: vi.fn(), unregister: vi.fn() }),
}));
vi.mock("../../shell/src/stores/chat-context.js", () => ({
  ChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../shell/src/lib/posthog-client.js", () => ({ capturePostHogEvent: vi.fn() }));
vi.mock("@matrix-os/observability/events", () => ({
  MATRIX_TELEMETRY_EVENTS: { SHELL_LOADED: "shell_loaded" },
}));
vi.mock("../../shell/src/components/Desktop.js", () => ({
  Desktop: (props: unknown) => {
    desktopProps(props);
    return <div data-testid="desktop" />;
  },
}));
vi.mock("../../shell/src/components/mobile/MobileShell.js", () => ({
  MobileShell: (props: unknown) => {
    mobileProps(props);
    return <div data-testid="mobile" />;
  },
}));
vi.mock("../../shell/src/components/CommandPalette.js", () => ({ CommandPalette: () => null }));
vi.mock("../../shell/src/components/ApprovalDialog.js", () => ({ ApprovalDialog: () => null }));

describe("ShellHome launch handoff", () => {
  beforeEach(() => {
    mobileViewport = false;
    desktopProps.mockClear();
    mobileProps.mockClear();
    window.history.replaceState(
      {},
      "",
      "/?launch=__terminal__&terminal_action=t3-connect",
    );
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("passes the exact URL handoff to the desktop renderer", async () => {
    const { ShellHome } = await import("../../shell/src/components/ShellHome.js");

    render(<ShellHome />);

    await waitFor(() => {
      expect(desktopProps).toHaveBeenCalledWith(
        expect.objectContaining({
          launchAppPath: "__terminal__",
          terminalLaunchAction: "t3-connect",
        }),
      );
    });
  });

  it("passes the exact URL handoff to the mobile renderer", async () => {
    mobileViewport = true;
    const { ShellHome } = await import("../../shell/src/components/ShellHome.js");

    render(<ShellHome />);

    await waitFor(() => {
      expect(mobileProps).toHaveBeenCalledWith(
        expect.objectContaining({
          launchAppPath: "__terminal__",
          terminalLaunchAction: "t3-connect",
        }),
      );
    });
  });
});
