// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VocalPanel } from "../../shell/src/components/VocalPanel.js";

const mocks = vi.hoisted(() => ({
  useVocalSession: vi.fn(),
}));
const originalConsoleError = console.error;

function isStyledJsxAttributeWarning(message: unknown, args: unknown[]): boolean {
  if (typeof message !== "string") return false;
  return (
    (message.includes("non-boolean attribute `jsx`") || message.includes("non-boolean attribute `global`")) ||
    (message.includes("non-boolean attribute `%s`") && (args.includes("jsx") || args.includes("global")))
  );
}

vi.mock("../../shell/src/hooks/useVocalSession.js", () => ({
  useVocalSession: (enabled: boolean, options: unknown) => mocks.useVocalSession(enabled, options),
}));

function baseVocalSession(error: string | null) {
  return {
    voiceState: "idle",
    subtitle: "",
    error,
    connected: false,
    notifyDelegationComplete: vi.fn(),
    notifyExecuteResult: vi.fn(),
    pushDelegationStatus: vi.fn(),
  };
}

describe("transient shell error placement", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation((message: unknown, ...args: unknown[]) => {
      if (isStyledJsxAttributeWarning(message, args)) {
        return;
      }
      Reflect.apply(originalConsoleError, console, [message, ...args]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("renders vocal shell errors in the top-right notification stack", async () => {
    mocks.useVocalSession.mockReturnValue(baseVocalSession("Aoede could not connect"));

    render(<VocalPanel active={true} />);

    const stack = await screen.findByTestId("shell-notification-stack");
    const alert = await screen.findByRole("alert");

    expect(stack.contains(alert)).toBe(true);
    expect(stack.className).toContain("right-3");
    expect(stack.className).toContain("top-[calc(env(safe-area-inset-top)+0.75rem)]");
    expect(alert.className).not.toContain("bottom-");
    expect(alert.textContent).toContain("Aoede could not connect");
  });
});
