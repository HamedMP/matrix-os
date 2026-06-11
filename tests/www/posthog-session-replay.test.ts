import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));

// www resolves its own posthog-js instance (www/node_modules), which is a
// different module id than the root copy the bare "posthog-js" specifier
// resolves to from this test file. Mock both so the www client gets the mock.
vi.mock("posthog-js", () => ({
  default: posthogMock,
}));
vi.mock("../../www/node_modules/posthog-js", () => ({
  default: posthogMock,
}));

const TEST_CONFIG = {
  token: "phc_test",
  apiHost: "/relay",
  uiHost: "https://eu.posthog.com",
};

async function importWwwPostHog() {
  vi.resetModules();
  return import("../../www/src/lib/posthog-client");
}

describe("www session replay init", () => {
  beforeEach(() => {
    posthogMock.init.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables masked session recording with console log capture", async () => {
    const { initializeWwwPostHog } = await importWwwPostHog();

    initializeWwwPostHog("US", TEST_CONFIG);

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.disable_session_recording).toBe(false);
    expect(options.enable_recording_console_log).toBe(true);
    expect(options.session_recording).toEqual({ maskAllInputs: true });
  });

  it("keeps session recording disabled when NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY", "1");
    const { initializeWwwPostHog } = await importWwwPostHog();

    initializeWwwPostHog("US", TEST_CONFIG);

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.disable_session_recording).toBe(true);
  });
});
