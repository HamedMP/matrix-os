// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_PREFERENCES_STATE_KEY,
  useProviderPreferences,
} from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

describe("provider preferences store", () => {
  beforeEach(() => {
    resetProviderPreferences();
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

  it("persists the bounded model, effort, and permission preference per Provider Instance", () => {
    useProviderPreferences.getState().setComposerSelection({
      instanceId: "codex_default",
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      interactionMode: "default",
      permissionMode: "full_access",
    });

    expect(useProviderPreferences.getState().composerSelections.codex_default).toEqual({
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });
    expect(useProviderPreferences.getState().lastComposerInstanceId).toBe("codex_default");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: PROVIDER_PREFERENCES_STATE_KEY,
      value: {
        defaultProviderId: null,
        lastComposerInstanceId: "codex_default",
        composerSelections: {
          codex_default: {
            model: "gpt-5.6-sol",
            options: [{ id: "effort", value: "high" }],
            permissionMode: "full_access",
          },
        },
      },
    });
  });

  it("hydrates effort and permission preferences without trusting malformed entries", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return Promise.resolve({
          value: {
            defaultProviderId: "codex",
            composerSelections: {
              codex_default: {
                options: [{ id: "effort", value: "high" }],
                permissionMode: "full_access",
              },
              "../escape": {
                options: [{ id: "effort", value: "ultra" }],
                permissionMode: "never",
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    await useProviderPreferences.getState().hydrate();

    expect(useProviderPreferences.getState().composerSelections).toEqual({
      codex_default: {
        options: [{ id: "effort", value: "high" }],
        permissionMode: "full_access",
      },
    });
  });

  it("hydrates the last Provider Instance and model while rejecting unsafe model references", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return Promise.resolve({
          value: {
            defaultProviderId: "codex",
            lastComposerInstanceId: "codex:work",
            composerSelections: {
              "codex:work": {
                model: "openai-codex/gpt-5.6-terra",
                options: [],
                permissionMode: "supervised",
              },
              codex_unsafe: {
                model: "../../private-model",
                options: [],
                permissionMode: "supervised",
              },
              codex_windows: {
                model: "C:/private-model",
                options: [],
                permissionMode: "supervised",
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    await useProviderPreferences.getState().hydrate();

    expect(useProviderPreferences.getState().lastComposerInstanceId).toBe("codex:work");
    expect(useProviderPreferences.getState().composerSelections).toEqual({
      "codex:work": {
        model: "openai-codex/gpt-5.6-terra",
        options: [],
        permissionMode: "supervised",
      },
    });
  });

  it("does not overwrite a picker change made while hydration is in flight", async () => {
    let resolveHydration!: (value: { value: null }) => void;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return new Promise((resolve) => { resolveHydration = resolve; });
      }
      return Promise.resolve({ ok: true });
    });

    const hydration = useProviderPreferences.getState().hydrate();
    useProviderPreferences.getState().setComposerSelection({
      instanceId: "codex_default",
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      interactionMode: "default",
      permissionMode: "full_access",
    });
    resolveHydration({ value: null });
    await hydration;

    expect(useProviderPreferences.getState().composerSelections.codex_default).toEqual({
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });
    expect(useProviderPreferences.getState().lastComposerInstanceId).toBe("codex_default");
  });

  it("hydrates the last Provider Instance and model while rejecting unsafe model references", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return Promise.resolve({
          value: {
            defaultProviderId: "codex",
            lastComposerInstanceId: "codex:work",
            composerSelections: {
              "codex:work": {
                model: "openai-codex/gpt-5.6-terra",
                options: [],
                permissionMode: "supervised",
              },
              codex_unsafe: {
                model: "../../private-model",
                options: [],
                permissionMode: "supervised",
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    await useProviderPreferences.getState().hydrate();

    expect(useProviderPreferences.getState().lastComposerInstanceId).toBe("codex:work");
    expect(useProviderPreferences.getState().composerSelections).toEqual({
      "codex:work": {
        model: "openai-codex/gpt-5.6-terra",
        options: [],
        permissionMode: "supervised",
      },
    });
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
