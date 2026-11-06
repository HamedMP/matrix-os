import { describe, expect, it, vi } from "vitest";
import { subscribePostHogFlag, type PostHogFlagClient } from "../../packages/ui/src/feature-flags.js";

type FlagsCallback = Parameters<PostHogFlagClient["onFeatureFlags"]>[0];

function makeClient(enabled: Record<string, boolean | undefined>) {
  let callback: FlagsCallback | null = null;
  const stop = vi.fn();
  const client: PostHogFlagClient = {
    onFeatureFlags: vi.fn((next: FlagsCallback) => {
      callback = next;
      return stop;
    }),
    isFeatureEnabled: vi.fn((key: string) => enabled[key]),
  };
  const fire = (context?: { errorsLoading?: boolean }) => callback?.([], {}, context);
  return { client, fire, stop };
}

describe("subscribePostHogFlag", () => {
  it("reports the flag's value each time PostHog loads flags", () => {
    const { client, fire } = makeClient({ "get-started-wizard": true });
    const listener = vi.fn();
    subscribePostHogFlag(client, "get-started-wizard", listener);
    fire({ errorsLoading: false });
    expect(listener).toHaveBeenLastCalledWith(true);
  });

  it("reports a flag missing from the project as off", () => {
    const { client, fire } = makeClient({});
    const listener = vi.fn();
    subscribePostHogFlag(client, "get-started-wizard", listener);
    fire();
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("reports unknown when PostHog failed to load flags", () => {
    const { client, fire } = makeClient({ "get-started-wizard": true });
    const listener = vi.fn();
    subscribePostHogFlag(client, "get-started-wizard", listener);
    fire({ errorsLoading: true });
    expect(listener).toHaveBeenLastCalledWith(undefined);
  });

  it("returns PostHog's unsubscribe", () => {
    const { client, stop } = makeClient({});
    subscribePostHogFlag(client, "get-started-wizard", vi.fn())();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unknown and logs when PostHog throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client: PostHogFlagClient = {
      onFeatureFlags: () => { throw new TypeError("not ready"); },
      isFeatureEnabled: () => undefined,
    };
    const listener = vi.fn();
    const unsubscribe = subscribePostHogFlag(client, "get-started-wizard", listener);
    expect(listener).toHaveBeenCalledWith(undefined);
    expect(warn).toHaveBeenCalledWith("[feature-flags] PostHog flags unavailable:", "TypeError");
    expect(() => unsubscribe()).not.toThrow();
    warn.mockRestore();
  });
});
