// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  useAuth: vi.fn(() => {
    throw new Error("Clerk useAuth should not run in self-host mode");
  }),
}));

const canonical = vi.hoisted(() => ({ useCanonicalChatState: vi.fn((_options?: { navigationScope?: string; initialChatId?: string | null }) => ({ newChat: vi.fn() })) }));

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

function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  render(<ShellHome />);
  return {
    launch: screen.getByTestId("desktop").getAttribute("data-launch"),
    initialChatId: canonical.useCanonicalChatState.mock.lastCall?.[0]?.initialChatId ?? null,
  };
}

describe("ShellHome chat deep link", () => {
  beforeEach(() => {
    process.env.MATRIX_SELF_HOSTED = "1";
    canonical.useCanonicalChatState.mockClear();
  });

  afterEach(() => {
    delete process.env.MATRIX_SELF_HOSTED;
    window.history.replaceState({}, "", "/");
    cleanup();
  });

  it("opens Chat on the linked conversation", () => {
    expect(renderAt("/?launch=__chat__&chat=chat_0123abcd")).toEqual({ launch: "__chat__", initialChatId: "chat_0123abcd" });
  });

  it("treats a chat parameter alone as a Chat launch", () => {
    expect(renderAt("/vm/alice/?chat=chat_0123abcd")).toEqual({ launch: "__chat__", initialChatId: "chat_0123abcd" });
  });

  it.each(["chat_", "proj_123", "chat_../x", "chat_%3Cscript%3E"])("ignores the invalid chat id %s", (id) => {
    expect(renderAt(`/?chat=${id}`)).toEqual({ launch: "", initialChatId: null });
  });

  it("ignores repeated chat parameters", () => {
    expect(renderAt("/?chat=chat_a1&chat=chat_b2")).toEqual({ launch: "", initialChatId: null });
  });
});
