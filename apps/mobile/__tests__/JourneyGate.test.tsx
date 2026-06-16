import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
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
  it("shows a loading state before the first result", () => {
    const { getByTestId } = render(<JourneyGate result={null} onRetry={noop} onOpenUrl={noop} />);
    expect(getByTestId("journey-loading")).toBeTruthy();
  });

  it("plan_required opens plans via the URL callback", () => {
    const onOpenUrl = jest.fn();
    const { getByTestId } = render(
      <JourneyGate result={ok({ phase: "plan_required", nextAction: { kind: "open_plans", url: "https://app.matrix-os.com/?plans=1" } })} onRetry={noop} onOpenUrl={onOpenUrl} />,
    );
    fireEvent.press(getByTestId("journey-open-plans"));
    expect(onOpenUrl).toHaveBeenCalledWith("https://app.matrix-os.com/?plans=1");
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

  it("plan_required always offers a Check again CTA, even without a URL", () => {
    const onRefresh = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <JourneyGate result={ok({ phase: "plan_required", nextAction: { kind: "open_plans" } })} onRetry={noop} onOpenUrl={noop} onRefresh={onRefresh} />,
    );
    expect(queryByTestId("journey-open-plans")).toBeNull();
    fireEvent.press(getByTestId("journey-refresh"));
    expect(onRefresh).toHaveBeenCalled();
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
});
