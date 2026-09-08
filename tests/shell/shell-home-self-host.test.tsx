// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  useAuth: vi.fn(() => {
    throw new Error("Clerk useAuth should not run in self-host mode");
  }),
}));

const commands = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: clerk.useAuth }));
vi.mock("@/hooks/useMobileViewport", () => ({ useMobileViewport: () => false }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: vi.fn() }));
vi.mock("@/hooks/useDesktopConfig", () => ({ useDesktopConfig: vi.fn() }));
vi.mock("@/hooks/useCanonicalChatState", () => ({
  useCanonicalChatState: () => ({ newChat: vi.fn() }),
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
  Desktop: () => <div data-testid="desktop">desktop</div>,
}));
vi.mock("@/components/mobile/MobileShell", () => ({ MobileShell: () => null }));
vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ApprovalDialog", () => ({ ApprovalDialog: () => null }));

import { ShellHome } from "@/components/ShellHome";

describe("ShellHome self-host mode", () => {
  beforeEach(() => {
    process.env.MATRIX_SELF_HOSTED = "1";
    clerk.useAuth.mockClear();
    commands.register.mockClear();
    commands.unregister.mockClear();
  });

  afterEach(() => {
    delete process.env.MATRIX_SELF_HOSTED;
  });

  it("renders the standalone shell without invoking Clerk", () => {
    expect(() => render(<ShellHome />)).not.toThrow();
    expect(screen.getByTestId("desktop")).toBeTruthy();
    expect(clerk.useAuth).not.toHaveBeenCalled();
  });
});
