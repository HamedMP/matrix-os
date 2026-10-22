// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  useAuth: vi.fn(() => {
    throw new Error("Clerk useAuth should not run in self-host mode");
  }),
}));

const canonical = vi.hoisted(() => ({ useCanonicalChatState: vi.fn((_options?: { navigationScope?: string }) => ({ newChat: vi.fn() })) }));

const commands = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: clerk.useAuth }));
vi.mock("@/hooks/useMobileViewport", () => ({ useMobileViewport: () => false }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: vi.fn() }));
vi.mock("@/hooks/useDesktopConfig", () => ({ useDesktopConfig: vi.fn() }));
vi.mock("@/hooks/useCanonicalChatState", () => ({
  useCanonicalChatState: canonical.useCanonicalChatState,
}));
vi.mock("@/hooks/useGlobalShortcuts", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("@/stores/commands", () => ({
  useCommandStore: (selector: (state: typeof commands) => unknown) => selector(commands),
}));
vi.mock("@/lib/posthog-client", () => ({ capturePostHogEvent: vi.fn() }));
vi.mock("@matrix-os/observability/events", () => ({
  MATRIX_TELEMETRY_EVENTS: { SHELL_LOADED: "shell_loaded" },
}));
vi.mock("@/components/Desktop", () => ({
  Desktop: ({ launchAppPath }: { launchAppPath: string | null }) => (
    <div data-testid="desktop" data-launch={launchAppPath ?? ""}>desktop</div>
  ),
}));
vi.mock("@/components/mobile/MobileShell", () => ({ MobileShell: () => null }));
vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ApprovalDialog", () => ({ ApprovalDialog: () => null }));

import { ShellHome } from "@/components/ShellHome";

describe("ShellHome self-host mode", () => {
  beforeEach(() => {
    process.env.MATRIX_SELF_HOSTED = "1";
    clerk.useAuth.mockClear();
    canonical.useCanonicalChatState.mockClear();
    commands.register.mockClear();
    commands.unregister.mockClear();
  });

  afterEach(() => {
    delete process.env.MATRIX_SELF_HOSTED;
    window.history.replaceState({}, "", "/");
    cleanup();
  });

  it("renders the standalone shell without invoking Clerk", () => {
    expect(() => render(<ShellHome />)).not.toThrow();
    expect(screen.getByTestId("desktop")).toBeTruthy();
    expect(clerk.useAuth).not.toHaveBeenCalled();
  });

  it("keeps collaboration routing in the standalone shell", () => {
    render(<ShellHome initialCollaborationView={{ kind: "terminal", scopeId: "scope_1" }} />);
    expect(screen.getByTestId("desktop").getAttribute("data-launch")).toBe("__terminal__");
    expect(clerk.useAuth).not.toHaveBeenCalled();
  });

  it("still reads the Clerk session in managed mode", () => {
    delete process.env.MATRIX_SELF_HOSTED;
    clerk.useAuth.mockImplementationOnce(() => ({ userId: "user_1", sessionId: "sess_1" }));
    render(<ShellHome />);
    expect(screen.getByTestId("desktop")).toBeTruthy();
    expect(clerk.useAuth).toHaveBeenCalled();
  });
  it("isolates Chat navigation by the gateway's effective runtime route", () => {
    delete process.env.MATRIX_SELF_HOSTED;
    clerk.useAuth.mockImplementation(() => ({ userId: "user_1", sessionId: "sess_1" }));
    const scopeAt = (url: string) => {
      window.history.replaceState({}, "", url);
      const view = render(<ShellHome />);
      const scope = (canonical.useCanonicalChatState.mock.lastCall?.[0] as { navigationScope?: string }).navigationScope;
      view.unmount();
      return scope;
    };
    const primary = scopeAt("/vm/alice");
    const review = scopeAt("/vm/alice?runtime=review");
    expect(primary).not.toBe(review);
    expect(scopeAt("/vm/alice?runtime=main")).not.toBe(review);
    expect(scopeAt("/vm/alice?runtime=../review")).toBe(primary);
    expect(scopeAt("/vm/alice?runtime=")).toBe(primary);
    expect(scopeAt("/vm/alice?runtime=review%2Fother")).toBe(primary);
    expect(scopeAt("/vm/alice?runtime=review&launch=__chat__")).toBe(review);
    expect(scopeAt("/vm/alice/canvas?runtime=review")).toBe(review);
    expect(scopeAt("/vm/alice-review")).not.toBe(review);
    expect(scopeAt("/?runtime=review")).toBe(scopeAt("/"));
  });

  it.each(["/shared/chat/scope_1", "/shared/project/scope_1"])("keeps mounted Chat transport scope when navigating to %s", pathname => {
    delete process.env.MATRIX_SELF_HOSTED;
    clerk.useAuth.mockImplementation(() => ({ userId: "user_1", sessionId: "sess_1" }));
    window.history.replaceState({}, "", "/vm/alice?runtime=review");
    const view = render(<ShellHome />);
    const before = canonical.useCanonicalChatState.mock.lastCall?.[0]?.navigationScope;
    expect(before).toContain(encodeURIComponent("/vm/alice/~runtime/review"));
    // Shared navigation changes only history; the canonical client remains mounted.
    window.history.pushState({}, "", pathname);
    view.rerender(<ShellHome />);
    expect(canonical.useCanonicalChatState.mock.lastCall?.[0]?.navigationScope).toBe(before);
    clerk.useAuth.mockImplementation(() => ({ userId: "user_2", sessionId: "sess_2" }));
    view.rerender(<ShellHome />);
    const nextViewer = canonical.useCanonicalChatState.mock.lastCall?.[0]?.navigationScope;
    expect(nextViewer).not.toBe(before);
    expect(nextViewer).toContain(encodeURIComponent("/vm/alice/~runtime/review"));
  });

});
