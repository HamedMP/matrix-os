describe("mobile feature flags", () => {
  const originalValue = process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE;

  afterEach(() => {
    jest.resetModules();
    if (originalValue === undefined) {
      delete process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE;
    } else {
      process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE = originalValue;
    }
  });

  it("keeps the coding-agent workspace disabled unless explicitly opted in", () => {
    delete process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE;

    jest.isolateModules(() => {
      const flags = require("../lib/feature-flags") as typeof import("../lib/feature-flags");

      expect(flags.CODING_AGENTS_MOBILE_WORKSPACE).toBe(false);
    });
  });

  it("enables the coding-agent workspace only for the explicit opt-in value", () => {
    process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE = "1";

    jest.isolateModules(() => {
      const flags = require("../lib/feature-flags") as typeof import("../lib/feature-flags");

      expect(flags.CODING_AGENTS_MOBILE_WORKSPACE).toBe(true);
    });
  });
});
