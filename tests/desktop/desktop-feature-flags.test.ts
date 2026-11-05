import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogClient = vi.hoisted(() => ({
  onFeatureFlags: vi.fn((_callback: unknown) => vi.fn()),
  isFeatureEnabled: vi.fn((_key: string) => true as boolean | undefined),
}));

vi.mock("posthog-js/dist/module.no-external", () => ({ default: posthogClient }));

async function loadModule() {
  vi.resetModules();
  return import("@desktop/renderer/src/features/support/desktop-feature-flags");
}

describe("Electron Desktop feature flags", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_desktop_test");
    posthogClient.onFeatureFlags.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has no flag source in builds without a PostHog project", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    const { createDesktopFeatureFlagSource } = await loadModule();
    expect(createDesktopFeatureFlagSource()).toBeUndefined();
  });

  it("waits for PostHog to initialize before listening, since an early listener only ever hears a load error", async () => {
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    const listener = vi.fn();
    createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", listener);
    expect(posthogClient.onFeatureFlags).not.toHaveBeenCalled();

    markDesktopFeatureFlagsReady();
    expect(posthogClient.onFeatureFlags).toHaveBeenCalledTimes(1);
    const callback = posthogClient.onFeatureFlags.mock.calls[0]![0] as (flags: string[], variants: object, context?: object) => void;
    callback([], {}, { errorsLoading: false });
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("listens straight away once PostHog is ready", async () => {
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    markDesktopFeatureFlagsReady();
    createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", vi.fn());
    expect(posthogClient.onFeatureFlags).toHaveBeenCalledTimes(1);
  });

  it("never starts a listener that unsubscribed while waiting", async () => {
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    const unsubscribe = createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", vi.fn());
    unsubscribe();
    markDesktopFeatureFlagsReady();
    expect(posthogClient.onFeatureFlags).not.toHaveBeenCalled();
  });

  it("stops PostHog's listener on unsubscribe", async () => {
    const stop = vi.fn();
    posthogClient.onFeatureFlags.mockReturnValueOnce(stop);
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    markDesktopFeatureFlagsReady();
    createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", vi.fn())();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("caps waiting listeners, dropping the oldest", async () => {
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady, MAX_PENDING_FLAG_LISTENERS } = await loadModule();
    const source = createDesktopFeatureFlagSource()!;
    for (let index = 0; index < MAX_PENDING_FLAG_LISTENERS + 3; index += 1) source.subscribe("get-started-wizard", vi.fn());
    markDesktopFeatureFlagsReady();
    expect(posthogClient.onFeatureFlags).toHaveBeenCalledTimes(MAX_PENDING_FLAG_LISTENERS);
  });

  it("reads flags from the recreated Support client instead of the discarded singleton", async () => {
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    const replacement = {
      onFeatureFlags: vi.fn((_callback: unknown) => vi.fn()),
      isFeatureEnabled: vi.fn(() => false),
    };
    const listener = vi.fn();
    createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", listener);
    markDesktopFeatureFlagsReady(replacement);
    expect(posthogClient.onFeatureFlags).not.toHaveBeenCalled();
    expect(replacement.onFeatureFlags).toHaveBeenCalledTimes(1);
    const callback = replacement.onFeatureFlags.mock.calls[0]![0] as (flags: string[], variants: object, context?: object) => void;
    callback([], {}, { errorsLoading: false });
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("rebinds mounted gates and ignores late callbacks from an old account", async () => {
    const stopOld = vi.fn();
    posthogClient.onFeatureFlags.mockReturnValueOnce(stopOld);
    const { createDesktopFeatureFlagSource, markDesktopFeatureFlagsReady } = await loadModule();
    markDesktopFeatureFlagsReady(posthogClient);
    const listener = vi.fn();
    const unsubscribe = createDesktopFeatureFlagSource()!.subscribe("get-started-wizard", listener);
    const oldCallback = posthogClient.onFeatureFlags.mock.calls[0]![0] as (flags: string[], variants: object) => void;
    const replacement = {
      onFeatureFlags: vi.fn((_callback: unknown) => vi.fn()),
      isFeatureEnabled: vi.fn(() => false),
    };
    markDesktopFeatureFlagsReady(replacement);
    expect(stopOld).toHaveBeenCalledTimes(1);
    expect(replacement.onFeatureFlags).toHaveBeenCalledTimes(1);
    oldCallback([], {});
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
