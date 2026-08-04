// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_PREFERENCES_STATE_KEY,
  useProviderPreferences,
} from "../../desktop/src/renderer/src/features/settings/provider-preferences";

describe("provider preferences store", () => {
  beforeEach(() => {
    useProviderPreferences.setState({ defaultProviderId: null, hydrated: false });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "state:get") return Promise.resolve({ value: null });
        return Promise.resolve({ ok: true });
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with the automatic default before hydration", () => {
    expect(useProviderPreferences.getState().defaultProviderId).toBeNull();
    expect(useProviderPreferences.getState().hydrated).toBe(false);
  });

  it("setDefaultProvider updates state and persists through the state bridge", () => {
    useProviderPreferences.getState().setDefaultProvider("claude-code");

    expect(useProviderPreferences.getState().defaultProviderId).toBe("claude-code");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: PROVIDER_PREFERENCES_STATE_KEY,
      value: { defaultProviderId: "claude-code" },
    });
  });

  it("setDefaultProvider(null) resets to the automatic default", () => {
    useProviderPreferences.getState().setDefaultProvider("codex");
    useProviderPreferences.getState().setDefaultProvider(null);

    expect(useProviderPreferences.getState().defaultProviderId).toBeNull();
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: PROVIDER_PREFERENCES_STATE_KEY,
      value: { defaultProviderId: null },
    });
  });

  it("ignores invalid provider ids instead of persisting them", () => {
    useProviderPreferences.getState().setDefaultProvider("../escape");

    expect(useProviderPreferences.getState().defaultProviderId).toBeNull();
    expect(window.operator.invoke).not.toHaveBeenCalledWith(
      "state:set",
      expect.objectContaining({ key: PROVIDER_PREFERENCES_STATE_KEY }),
    );
  });

  it("hydrate applies a persisted default provider", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return Promise.resolve({ value: { defaultProviderId: "codex" } });
      }
      return Promise.resolve({ ok: true });
    });

    await useProviderPreferences.getState().hydrate();

    expect(useProviderPreferences.getState().defaultProviderId).toBe("codex");
    expect(useProviderPreferences.getState().hydrated).toBe(true);
  });

  it("hydrate falls back to automatic when the persisted value is malformed", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return Promise.resolve({ value: { defaultProviderId: "../../not-a-slug" } });
      }
      return Promise.resolve({ ok: true });
    });

    await useProviderPreferences.getState().hydrate();

    expect(useProviderPreferences.getState().defaultProviderId).toBeNull();
    expect(useProviderPreferences.getState().hydrated).toBe(true);
  });

  it("keeps working in memory when persistence is unavailable", async () => {
    window.operator.invoke = vi.fn(() => Promise.reject(new Error("invalid request")));

    await useProviderPreferences.getState().hydrate();
    useProviderPreferences.getState().setDefaultProvider("codex");

    expect(useProviderPreferences.getState().hydrated).toBe(true);
    expect(useProviderPreferences.getState().defaultProviderId).toBe("codex");
  });
});
