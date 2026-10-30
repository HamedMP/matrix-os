// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  opt_in_capturing: vi.fn(),
  onFeatureFlags: vi.fn((_callback: unknown) => vi.fn()),
  isFeatureEnabled: vi.fn((_key: string) => true as boolean | undefined),
}));

vi.mock("posthog-js/dist/conversations", () => ({}));
vi.mock("posthog-js", () => ({ default: posthogMock }));

const TEST_CONFIG = { token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" };

describe("shell PostHog feature flags", () => {
  it("has no flag source in builds without a PostHog project", async () => {
    const { getShellFeatureFlagSource } = await import("../../shell/src/lib/posthog-client");
    expect(getShellFeatureFlagSource(null)).toBeUndefined();
  });

  it("initializes PostHog before listening for flags", async () => {
    const { getShellFeatureFlagSource } = await import("../../shell/src/lib/posthog-client");
    const listener = vi.fn();
    getShellFeatureFlagSource(TEST_CONFIG)!.subscribe("get-started-wizard", listener);

    expect(posthogMock.init).toHaveBeenCalled();
    expect(posthogMock.init.mock.invocationCallOrder[0]).toBeLessThan(posthogMock.onFeatureFlags.mock.invocationCallOrder[0]!);
    const callback = posthogMock.onFeatureFlags.mock.calls[0]![0] as (flags: string[], variants: object, context?: object) => void;
    callback([], {}, { errorsLoading: false });
    expect(listener).toHaveBeenCalledWith(true);
  });
});
