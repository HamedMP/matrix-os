// @vitest-environment jsdom

import React, { type ReactElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import SharedChatPage from "../../shell/src/app/shared/chat/[scopeId]/page";
import SharedTerminalPage from "../../shell/src/app/shared/terminal/[scopeId]/page";
import SharedInvitationPage from "../../shell/src/app/shared/invitations/[invitationId]/page";
import { MobileShell } from "../../shell/src/components/mobile/MobileShell";
import {
  resetWindowManagerLayoutPersistenceForTests,
  useWindowManager,
} from "../../shell/src/hooks/useWindowManager";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("../../shell/src/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));
vi.mock("../../shell/src/components/terminal/TerminalApp", () => ({
  TerminalApp: ({ sharedScopeId }: { sharedScopeId?: string | null }) => (
    <div data-testid="mobile-terminal" data-shared-scope={sharedScopeId ?? undefined} />
  ),
}));
vi.mock("../../shell/src/components/Settings", () => ({ Settings: () => null }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const scopeId = "10000000-0000-4000-8000-000000000001";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function componentNames(node: ReactNode): string[] {
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type = element.type;
  const name = typeof type === "string" ? type : type.displayName ?? type.name;
  return [name, ...React.Children.toArray(element.props.children).flatMap(componentNames)];
}

describe("shared Chat deep link", () => {
  it("bootstraps the complete shell with Chat focused instead of rendering CollaborationPage", async () => {
    const page = await SharedChatPage({ params: Promise.resolve({ scopeId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(scopeId);
  });

  it("rejects malformed scope IDs at the server route boundary", async () => {
    await expect(SharedChatPage({
      params: Promise.resolve({ scopeId: "../../not-a-scope" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("shared Terminal deep link", () => {
  it("bootstraps the complete shell with the native Terminal focused", async () => {
    const page = await SharedTerminalPage({ params: Promise.resolve({ scopeId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(scopeId);
  });

  it("rejects malformed scope IDs at the server route boundary", async () => {
    await expect(SharedTerminalPage({
      params: Promise.resolve({ scopeId: "../../not-a-scope" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("keeps the validated shared scope in metadata on the canonical Terminal path", () => {
    resetWindowManagerLayoutPersistenceForTests();
    useWindowManager.setState({
      windows: [],
      nextZ: 1,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      focusedWindowId: null,
      fullscreenWindowId: null,
    });

    try {
      useWindowManager.getState().openWindow("Shared Terminal", "__terminal__", 80, {
        terminalPersistence: "ephemeral",
        sharedTerminalScopeId: scopeId,
      });
      const opened = useWindowManager.getState().windows[0];
      expect(opened.path).toBe("__terminal__");
      expect(opened.sharedTerminalScopeId).toBe(scopeId);
      expect(opened.terminalLayoutId).toBeUndefined();
    } finally {
      resetWindowManagerLayoutPersistenceForTests();
    }
  });

  it("never substitutes an unrelated terminal when a shared launch reaches mobile capacity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    const { rerender } = render(<MobileShell />);
    await act(async () => Promise.resolve());
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        fireEvent.click(screen.getByLabelText("Terminal"));
      }
    });
    expect(screen.getAllByTestId("mobile-terminal")).toHaveLength(5);

    const requestedScopeId = "20000000-0000-4000-8000-000000000002";
    rerender(<MobileShell launchAppPath="__terminal__" sharedTerminalScopeId={requestedScopeId} />);

    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      "Close a Terminal before opening this shared session",
    ));
    expect(screen.getAllByTestId("mobile-terminal")).toHaveLength(5);
    expect(document.querySelector(`[data-shared-scope="${requestedScopeId}"]`)).toBeNull();

    fireEvent.click(screen.getByLabelText("Open"));
    fireEvent.click(await screen.findAllByRole("button", { name: "Close Terminal" }).then((buttons) => buttons[0]!));
    await waitFor(() => expect(document.querySelector(
      `[data-shared-scope="${requestedScopeId}"]`,
    )).not.toBeNull());
  });
});

describe("collaboration invitation deep link", () => {
  it("resolves into the native Matrix shell", async () => {
    const invitationId = "30000000-0000-4000-8000-000000000001";
    const page = await SharedInvitationPage({ params: Promise.resolve({ invitationId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(invitationId);
  });

  it("rejects malformed invitation IDs at the route boundary", async () => {
    await expect(SharedInvitationPage({
      params: Promise.resolve({ invitationId: "../../not-an-invitation" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
