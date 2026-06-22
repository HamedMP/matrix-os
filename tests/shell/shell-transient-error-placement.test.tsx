// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingScreen } from "../../shell/src/components/OnboardingScreen.js";
import { VocalPanel } from "../../shell/src/components/VocalPanel.js";

const mocks = vi.hoisted(() => ({
  useOnboarding: vi.fn(),
  useMicPermission: vi.fn(),
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

vi.mock("../../shell/src/hooks/useOnboarding.js", () => ({
  useOnboarding: () => mocks.useOnboarding(),
}));

vi.mock("../../shell/src/hooks/useMicPermission.js", () => ({
  useMicPermission: () => mocks.useMicPermission(),
}));

vi.mock("../../shell/src/hooks/useVocalSession.js", () => ({
  useVocalSession: (enabled: boolean, options: unknown) => mocks.useVocalSession(enabled, options),
}));

vi.mock("../../shell/src/components/onboarding/VoiceWave.js", () => ({
  VoiceWave: () => <div data-testid="voice-wave" />,
}));

vi.mock("../../shell/src/components/onboarding/ApiKeyInput.js", () => ({
  ApiKeyInput: () => <div data-testid="api-key-input" />,
}));

vi.mock("../../shell/src/components/MicPermissionDialog.js", () => ({
  MicPermissionDialog: () => null,
}));

function baseOnboardingState(error: string | null) {
  return {
    stage: "connecting",
    voiceState: "idle",
    transcripts: [],
    suggestedApps: [],
    error,
    isVoiceMode: false,
    alreadyComplete: false,
    apiKeyResult: null,
    currentSubtitle: "",
    contextualContent: null,
    readiness: null,
    selectedGoalIds: [],
    onboardingSteps: [],
    start: vi.fn(),
    sendText: vi.fn(),
    sendApiKey: vi.fn(),
    confirmApps: vi.fn(),
    selectGoal: vi.fn(),
    refreshReadiness: vi.fn(),
    chooseClaudeCode: vi.fn(),
    finishInterview: vi.fn(),
  };
}

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

  it("renders onboarding shell errors in the top-right notification stack", () => {
    mocks.useOnboarding.mockReturnValue(baseOnboardingState("Onboarding connection failed"));
    mocks.useMicPermission.mockReturnValue({ state: "prompt", requestAccess: vi.fn() });

    render(<OnboardingScreen onComplete={vi.fn()} onOpenManualSetup={vi.fn()} />);

    const stack = screen.getByTestId("shell-notification-stack");
    const alert = screen.getByRole("alert");

    expect(stack.contains(alert)).toBe(true);
    expect(stack.className).toContain("right-3");
    expect(stack.className).toContain("top-[calc(env(safe-area-inset-top)+0.75rem)]");
    expect(alert.className).not.toContain("bottom-");
    expect(alert.textContent).toContain("Onboarding connection failed");
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
