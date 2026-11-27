import React from "react";
import { fireEvent, render, within } from "@testing-library/react-native";
import { Platform, ScrollView, StyleSheet } from "react-native";
import { FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";
import { JourneyGate } from "../components/JourneyGate";
import type { JourneyFetchResult, MobileJourneyState } from "../lib/journey";

function ok(journey: Partial<MobileJourneyState>): JourneyFetchResult {
  return {
    status: "ok",
    journey: { phase: "plan_required", detail: "detail", nextAction: { kind: "open_plans" }, ...journey } as MobileJourneyState,
  };
}

const noop = () => {};

describe("JourneyGate", () => {
  it("waits on the startup screen before the first result, as every launch wait does", () => {
    const { getByTestId } = render(<JourneyGate result={null} onRetry={noop} onOpenUrl={noop} />);
    expect(getByTestId("journey-loading")).toBeTruthy();
    expect(getByTestId("startup-screen")).toBeTruthy();
  });

  it("account_required prompts re-sign-in with an actionable button", () => {
    const onSignOut = jest.fn();
    const { getByText, queryByTestId, getByTestId } = render(
      <JourneyGate result={ok({ phase: "account_required", detail: "Sign in to continue." })} onRetry={noop} onOpenUrl={noop} onSignOut={onSignOut} />,
    );
    expect(getByText("Please sign in again")).toBeTruthy();
    expect(queryByTestId("journey-loading")).toBeNull();
    fireEvent.press(getByTestId("journey-sign-in"));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("shows a calm settling state within the window", () => {
    const { getByText, getByTestId } = render(
      <JourneyGate result={ok({ phase: "payment_settling", detail: "Activating…", settling: { since: "x", delayed: false } })} onRetry={noop} onOpenUrl={noop} />,
    );
    expect(getByText("Activating your subscription")).toBeTruthy();
    expect(getByTestId("journey-loading")).toBeTruthy();
  });

  it("shows the build stage during provisioning", () => {
    const { getByText } = render(
      <JourneyGate result={ok({ phase: "provisioning", detail: "Building…", progress: { stage: "booting", startedAt: "x" } })} onRetry={noop} onOpenUrl={noop} />,
    );
    expect(getByText("Booting your computer")).toBeTruthy();
  });

  it("calls the first build stage creating the Matrix computer", () => {
    const { getByText } = render(
      <JourneyGate result={ok({ phase: "provisioning", detail: "Building…", progress: { stage: "creating_server", startedAt: "x" } })} onRetry={noop} onOpenUrl={noop} />,
    );
    expect(getByText("Creating your Matrix computer")).toBeTruthy();
  });

  it("lets a free-plan owner start building their computer without plans", () => {
    const onRetry = jest.fn();
    const { getByText, getByTestId, queryByTestId } = render(
      <JourneyGate
        result={ok({ phase: "install_choices_required", detail: "Set up your free Matrix computer.", nextAction: { kind: "start_provision" } })}
        onRetry={onRetry}
        onOpenUrl={noop}
      />,
    );
    expect(getByText("Set up your Matrix computer")).toBeTruthy();
    expect(getByText("Set up your free Matrix computer.")).toBeTruthy();
    expect(queryByTestId("journey-open-plans")).toBeNull();
    fireEvent.press(getByTestId("journey-start"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("tells a free-plan owner which coding agents come preinstalled, as the web install step does", () => {
    const { getByText } = render(
      <JourneyGate
        result={ok({ phase: "install_choices_required", detail: "Set up your free Matrix computer.", nextAction: { kind: "start_provision" } })}
        onRetry={noop}
        onOpenUrl={noop}
      />,
    );
    expect(getByText(
      "Claude Code and Codex come preinstalled on your free computer. You can install OpenCode or Pi later from the Terminal’s + menu.",
    )).toBeTruthy();
  });

  it("tells a free-plan owner their computer sleeps when idle and wakes on open (ENG-520)", () => {
    const { getByText } = render(
      <JourneyGate
        result={ok({ phase: "install_choices_required", detail: "Set up your free Matrix computer.", nextAction: { kind: "start_provision" } })}
        onRetry={noop}
        onOpenUrl={noop}
      />,
    );
    expect(getByText(FREE_PLAN_COPY.sleep)).toBeTruthy();
  });

  it("shows why a free start failed and lets the owner try again", () => {
    const onRetry = jest.fn();
    const { getByText, getByTestId } = render(
      <JourneyGate
        result={ok({ phase: "install_choices_required", detail: "Set up your free Matrix computer.", nextAction: { kind: "start_provision" } })}
        onRetry={onRetry}
        onOpenUrl={noop}
        setupError="Matrix can’t start new computers right now. Try again in a few minutes."
      />,
    );
    expect(getByText("Matrix can’t start new computers right now. Try again in a few minutes.")).toBeTruthy();
    fireEvent.press(getByTestId("journey-start"));
    expect(onRetry).toHaveBeenCalled();
    expect(getByText("Try again")).toBeTruthy();
  });

  it("shows why a retry failed on the failed-build screen", () => {
    const { getByText, getByTestId } = render(
      <JourneyGate
        result={ok({ phase: "provisioning_failed", detail: "Setting up ran into a problem.", failure: { retryable: true, attempt: 1 } })}
        onRetry={noop}
        onOpenUrl={noop}
        setupError="Setup was just tried. Wait a moment, then try again."
      />,
    );
    expect(getByText("Setup was just tried. Wait a moment, then try again.")).toBeTruthy();
    expect(getByTestId("journey-retry")).toBeTruthy();
  });

  it("keeps the existing hand-off screen for install choices that are not a free start", () => {
    const { queryByTestId, getByTestId } = render(
      <JourneyGate result={ok({ phase: "install_choices_required", nextAction: { kind: "choose_default_installs" } })} onRetry={noop} onOpenUrl={noop} />,
    );
    expect(queryByTestId("journey-start")).toBeNull();
    expect(getByTestId("journey-loading")).toBeTruthy();
  });

  it("offers retry on a retryable failure", () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <JourneyGate result={ok({ phase: "provisioning_failed", failure: { retryable: true, attempt: 1 } })} onRetry={onRetry} onOpenUrl={noop} />,
    );
    fireEvent.press(getByTestId("journey-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("offers contact-support and refresh (not retry) once exhausted", () => {
    const onOpenUrl = jest.fn();
    const onRefresh = jest.fn();
    const { queryByTestId, getByText, getByTestId } = render(
      <JourneyGate result={ok({ phase: "provisioning_failed", failure: { retryable: false, attempt: 3 } })} onRetry={noop} onOpenUrl={onOpenUrl} onRefresh={onRefresh} />,
    );
    expect(getByText("Setup needs attention")).toBeTruthy();
    expect(queryByTestId("journey-retry")).toBeNull();
    fireEvent.press(getByTestId("journey-support"));
    expect(onOpenUrl).toHaveBeenCalledWith("mailto:support@matrix-os.com");
    fireEvent.press(getByTestId("journey-refresh"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("offers contact-support when payment settling is delayed", () => {
    const onOpenUrl = jest.fn();
    const { getByText, getByTestId, queryByTestId } = render(
      <JourneyGate result={ok({ phase: "payment_settling", detail: "Delayed…", settling: { since: "x", delayed: true } })} onRetry={noop} onOpenUrl={onOpenUrl} />,
    );
    expect(getByText("Taking longer than expected")).toBeTruthy();
    expect(queryByTestId("journey-loading")).toBeNull();
    fireEvent.press(getByTestId("journey-support"));
    expect(onOpenUrl).toHaveBeenCalledWith("mailto:support@matrix-os.com");
  });

  it("shows a retry on an unreachable result", () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(<JourneyGate result={{ status: "unreachable" }} onRetry={onRetry} onOpenUrl={noop} />);
    fireEvent.press(getByTestId("journey-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("prompts re-sign-in when unauthorized, with a sign-in action", () => {
    const onSignOut = jest.fn();
    const { getByText, getByTestId } = render(<JourneyGate result={{ status: "unauthorized" }} onRetry={noop} onOpenUrl={noop} onSignOut={onSignOut} />);
    expect(getByText("Please sign in again")).toBeTruthy();
    fireEvent.press(getByTestId("journey-sign-in"));
    expect(onSignOut).toHaveBeenCalled();
  });

  describe("plan_required in native store builds", () => {
    // Server copy and URL as sent by packages/platform/src/journey.ts.
    const PLANS_URL = "https://app.matrix-os.com/?plans=1";
    const SERVER_DETAIL = "Choose a plan to create your Matrix computer.";
    const planRequired = () => ok({ phase: "plan_required", detail: SERVER_DETAIL, nextAction: { kind: "open_plans", url: PLANS_URL } });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each(["ios", "android"] as const)("keeps every action in scrollable content for short screens and large text on %s", (os) => {
      jest.replaceProperty(Platform, "OS", os);
      const result = render(<JourneyGate result={planRequired()} onRetry={noop} onOpenUrl={noop} />);
      const scrollView = result.UNSAFE_getByType(ScrollView);
      expect(StyleSheet.flatten(scrollView.props.contentContainerStyle).flexGrow).toBe(1);
      for (const action of ["journey-refresh", "journey-sign-out", "journey-support"]) {
        expect(within(scrollView).getByTestId(action)).toBeTruthy();
      }
    });

    it.each(["ios", "android"] as const)("shows neutral copy with no purchase call to action on %s", (os) => {
      jest.replaceProperty(Platform, "OS", os);
      const onOpenUrl = jest.fn();
      const { getByText, queryByText, queryByTestId, getByTestId } = render(
        <JourneyGate result={planRequired()} onRetry={noop} onOpenUrl={onOpenUrl} />,
      );

      expect(getByText("No active plan")).toBeTruthy();
      expect(getByText("This account doesn’t have an active Matrix computer plan. If you expected access, check again or sign in with another account.")).toBeTruthy();
      expect(queryByText(SERVER_DETAIL)).toBeNull();
      expect(queryByText("Choose your plan")).toBeNull();
      expect(queryByText("View plans")).toBeNull();
      expect(queryByTestId("journey-open-plans")).toBeNull();
      expect(queryByText(/pricing|choose|website|browser|subscribe|upgrade|buy|purchase|matrix-os\.com/i)).toBeNull();

      fireEvent.press(getByTestId("journey-refresh"));
      fireEvent.press(getByTestId("journey-sign-out"));
      expect(onOpenUrl).not.toHaveBeenCalled();
    });

    it("keeps Check again so the user can re-check their account", () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const onRefresh = jest.fn();
      const { getByTestId } = render(
        <JourneyGate result={planRequired()} onRetry={noop} onOpenUrl={noop} onRefresh={onRefresh} />,
      );
      fireEvent.press(getByTestId("journey-refresh"));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it.each(["ios", "android"] as const)("offers support without sending the user to checkout on %s", (os) => {
      jest.replaceProperty(Platform, "OS", os);
      const onOpenUrl = jest.fn();
      const { getByTestId } = render(
        <JourneyGate result={planRequired()} onRetry={noop} onOpenUrl={onOpenUrl} />,
      );
      fireEvent.press(getByTestId("journey-support"));
      expect(onOpenUrl).toHaveBeenCalledTimes(1);
      expect(onOpenUrl).toHaveBeenCalledWith("mailto:support@matrix-os.com");
    });

    it("offers Sign out so the user can switch accounts", () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const onSignOut = jest.fn();
      const { getByTestId, getByText } = render(
        <JourneyGate result={planRequired()} onRetry={noop} onOpenUrl={noop} onSignOut={onSignOut} />,
      );
      expect(getByText("Sign out")).toBeTruthy();
      fireEvent.press(getByTestId("journey-sign-out"));
      expect(onSignOut).toHaveBeenCalledTimes(1);
    });
  });

  describe("plan_required in the web build", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "web");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("shows the server detail and opens plans via the URL callback", () => {
      const onOpenUrl = jest.fn();
      const { getByTestId, getByText, queryByTestId } = render(
        <JourneyGate result={ok({ phase: "plan_required", detail: "Choose a plan to create your Matrix computer.", nextAction: { kind: "open_plans", url: "https://app.matrix-os.com/?plans=1" } })} onRetry={noop} onOpenUrl={onOpenUrl} />,
      );
      expect(getByText("Choose your plan")).toBeTruthy();
      expect(getByText("Choose a plan to create your Matrix computer.")).toBeTruthy();
      expect(queryByTestId("journey-sign-out")).toBeNull();
      fireEvent.press(getByTestId("journey-open-plans"));
      expect(onOpenUrl).toHaveBeenCalledWith("https://app.matrix-os.com/?plans=1");
    });

    it("always offers a Check again CTA, even without a URL", () => {
      const onRefresh = jest.fn();
      const { getByTestId, queryByTestId } = render(
        <JourneyGate result={ok({ phase: "plan_required", nextAction: { kind: "open_plans" } })} onRetry={noop} onOpenUrl={noop} onRefresh={onRefresh} />,
      );
      expect(queryByTestId("journey-open-plans")).toBeNull();
      fireEvent.press(getByTestId("journey-refresh"));
      expect(onRefresh).toHaveBeenCalled();
    });
  });
});
