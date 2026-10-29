// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GET_STARTED_FEATURE_FLAG } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";
import { FEATURE_FLAG_TIMEOUT_MS, type FeatureFlagSource } from "../../packages/ui/src/feature-flags.js";

const AT = "2026-10-29T10:00:00.000Z";

function makePort(initial: unknown): GetStartedPort {
  return {
    load: vi.fn(async () => initial),
    save: vi.fn(async () => ({ status: "skipped", skippedAt: AT })),
  };
}

/** A PostHog stand-in the test drives: `emit` delivers a flag evaluation to every subscriber. */
function makeFlags() {
  const listeners = new Map<string, Set<(enabled: boolean | undefined) => void>>();
  const unsubscribed = vi.fn();
  const source: FeatureFlagSource = {
    subscribe: vi.fn((key: string, listener: (enabled: boolean | undefined) => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        unsubscribed(key);
      };
    }),
  };
  const emit = (key: string, enabled: boolean | undefined) => {
    act(() => {
      for (const listener of listeners.get(key) ?? []) listener(enabled);
    });
  };
  return { source, emit, unsubscribed };
}

function renderGate(port: GetStartedPort, featureFlags?: FeatureFlagSource) {
  return render(
    <GetStartedGate port={port} zIndex={690} featureFlags={featureFlags}>
      <div data-testid="desktop-widget">widget</div>
    </GetStartedGate>,
  );
}

/** Lets the port's load promise settle without advancing fake timers. */
async function settleLoad() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GetStartedGate rollout flag", () => {
  it("names the PostHog flag the gate reads", () => {
    expect(GET_STARTED_FEATURE_FLAG).toBe("get-started-wizard");
  });

  it("shows the wizard to a new computer when the flag is on", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    expect(flags.source.subscribe).toHaveBeenCalledWith(GET_STARTED_FEATURE_FLAG, expect.any(Function));
    flags.emit(GET_STARTED_FEATURE_FLAG, true);
    expect(await screen.findByPlaceholderText("Your first name")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
  });

  it("keeps today's desktop when the flag is off", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    flags.emit(GET_STARTED_FEATURE_FLAG, false);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Your first name")).not.toBeInTheDocument();
  });

  it("fails closed when PostHog could not load flags", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    flags.emit(GET_STARTED_FEATURE_FLAG, undefined);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Your first name")).not.toBeInTheDocument();
  });

  it("shows neither the wizard nor the widget while the flag is loading, then falls back after the timeout", async () => {
    vi.useFakeTimers();
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Your first name")).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(FEATURE_FLAG_TIMEOUT_MS); });
    expect(screen.getByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Your first name")).not.toBeInTheDocument();
  });

  it("opens the wizard if the flag arrives on after the timeout", async () => {
    vi.useFakeTimers();
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    act(() => { vi.advanceTimersByTime(FEATURE_FLAG_TIMEOUT_MS); });
    expect(screen.getByTestId("desktop-widget")).toBeInTheDocument();

    flags.emit(GET_STARTED_FEATURE_FLAG, true);
    expect(screen.getByPlaceholderText("Your first name")).toBeInTheDocument();
  });

  it("never closes an open wizard when the flag later turns off", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    flags.emit(GET_STARTED_FEATURE_FLAG, true);
    await screen.findByPlaceholderText("Your first name");

    flags.emit(GET_STARTED_FEATURE_FLAG, false);
    expect(screen.getByPlaceholderText("Your first name")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
  });

  it("does not wait for the flag when setup is already finished", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "completed", completedAt: AT, answers: { goals: ["code"], tools: [] } }), flags.source);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
  });

  it("does not wait for the flag when the computer is not eligible", async () => {
    const flags = makeFlags();
    renderGate(makePort({ status: "not_eligible" }), flags.source);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
  });

  it("leaves the gateway to decide where PostHog is not configured", async () => {
    renderGate(makePort({ status: "pending" }));
    expect(await screen.findByPlaceholderText("Your first name")).toBeInTheDocument();
  });

  it("stops listening for flags when the gate unmounts", async () => {
    const flags = makeFlags();
    const view = renderGate(makePort({ status: "pending" }), flags.source);
    await settleLoad();
    view.unmount();
    expect(flags.unsubscribed).toHaveBeenCalledWith(GET_STARTED_FEATURE_FLAG);
  });
});
