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

  it("offers no retry once exhausted", () => {
    const { queryByTestId, getByText } = render(
      <JourneyGate result={ok({ phase: "provisioning_failed", failure: { retryable: false, attempt: 3 } })} onRetry={noop} onOpenUrl={noop} />,
    );
    expect(getByText("Setup needs attention")).toBeTruthy();
    expect(queryByTestId("journey-retry")).toBeNull();
  });

  it("shows a retry on an unreachable result", () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(<JourneyGate result={{ status: "unreachable" }} onRetry={onRetry} onOpenUrl={noop} />);
    fireEvent.press(getByTestId("journey-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("prompts re-sign-in when unauthorized", () => {
    const { getByText } = render(<JourneyGate result={{ status: "unauthorized" }} onRetry={noop} onOpenUrl={noop} />);
    expect(getByText("Please sign in again")).toBeTruthy();
  });
});
