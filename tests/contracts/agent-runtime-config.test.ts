import { describe, expect, it } from "vitest";
import {
  AgentProviderDescriptorSchema,
  AgentRuntimeIdSchema,
  AgentSettingsCompatibleViewSchema,
  AgentSettingsUpdateSchema,
  AgentSettingsViewSchema,
  type AgentSettingsView,
} from "@matrix-os/contracts";

const chatSelection = {
  provider: "anthropic",
  model: "claude-opus-4-6",
  effort: "high",
  source: "saved",
  authKind: "platform",
} as const;

const chatProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  runtime: null,
  scopes: ["chat"],
  authKind: "platform",
  supportedAuthKinds: ["platform", "api_key", "oauth_login"],
  models: [{
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    capabilities: ["tools", "vision", "reasoning"],
    efforts: ["low", "medium", "high", "max"],
    available: true,
  }],
  authStatus: { state: "ready", authenticated: true, action: "none" },
} as const;

const hermesProvider = {
  id: "nous",
  displayName: "Nous Research",
  runtime: "hermes",
  scopes: ["messaging"],
  authKind: "api_key",
  supportedAuthKinds: ["api_key"],
  models: [{
    id: "hermes-4-405b",
    displayName: "Hermes 4 405B",
    capabilities: ["tools"],
    efforts: [],
    available: true,
  }],
  authStatus: { state: "ready", authenticated: true, action: "none" },
} as const;

function makeView(overrides: Partial<AgentSettingsView> = {}): AgentSettingsView {
  const base = {
    identity: { name: "Matrix Owner" },
    kernel: { model: "claude-opus-4-6", effort: "high" },
    availableModels: [{
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      tier: "Most capable",
    }],
    availableEfforts: ["low", "medium", "high", "max"],
    defaults: { model: "claude-opus-4-6", effort: "high" },
    contractVersion: 2,
    revision: 4,
    chat: chatSelection,
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: "healthy",
          selectionState: "active",
          configured: true,
          capabilities: ["provider_catalog", "model_selection", "authentication"],
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "action_required",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers: [chatProvider, hermesProvider],
    currentSelection: {
      chat: chatSelection,
      messaging: {
        runtime: "hermes",
        provider: "nous",
        model: "hermes-4-405b",
        configured: true,
      },
    },
  } as const;
  return { ...base, ...overrides } as AgentSettingsView;
}

describe("agent runtime configuration contracts", () => {
  it.each(["hermes", "openclaw"])("accepts the %s messaging runtime", (runtime) => {
    expect(AgentRuntimeIdSchema.parse(runtime)).toBe(runtime);
  });

  it("does not conflate messaging runtimes with Matrix computer runtime ids", () => {
    expect(AgentRuntimeIdSchema.safeParse("rt_primary").success).toBe(false);
  });

  it("accepts a provider with secret-free auth status", () => {
    expect(AgentProviderDescriptorSchema.parse(chatProvider)).toEqual(chatProvider);
  });

  it("requires the effective auth kind to be supported", () => {
    const provider = {
      ...chatProvider,
      authKind: "oauth_login",
      supportedAuthKinds: ["platform"],
    };
    expect(AgentProviderDescriptorSchema.safeParse(provider).success).toBe(false);
  });

  it("rejects duplicate model ids within a provider", () => {
    const provider = { ...chatProvider, models: [chatProvider.models[0], chatProvider.models[0]] };
    expect(AgentProviderDescriptorSchema.safeParse(provider).success).toBe(false);
  });

  it("rejects credential-shaped fields in auth status", () => {
    const provider = {
      ...chatProvider,
      authStatus: { ...chatProvider.authStatus, apiKey: "sk-secret" },
    };
    expect(AgentProviderDescriptorSchema.safeParse(provider).success).toBe(false);
  });

  it("accepts the complete additive settings view", () => {
    expect(AgentSettingsViewSchema.parse(makeView()).contractVersion).toBe(2);
  });

  it("requires the top-level and grouped Chat selections to match", () => {
    const view = makeView({
      currentSelection: {
        chat: { ...chatSelection, effort: "low" },
        messaging: makeView().currentSelection.messaging,
      },
    });
    expect(AgentSettingsViewSchema.safeParse(view).success).toBe(false);
  });

  it("requires exactly one active descriptor for the selected runtime", () => {
    const view = makeView({
      runtime: {
        ...makeView().runtime,
        selected: "openclaw",
      },
    });
    expect(AgentSettingsViewSchema.safeParse(view).success).toBe(false);
  });

  it("requires configured messaging selection to exist in the selected provider catalog", () => {
    const view = makeView({
      currentSelection: {
        chat: chatSelection,
        messaging: {
          runtime: "hermes",
          provider: "missing-provider",
          model: "missing-model",
          configured: true,
        },
      },
    });
    expect(AgentSettingsViewSchema.safeParse(view).success).toBe(false);
  });

  it("rejects duplicate provider ids in the same runtime scope", () => {
    const view = makeView({ providers: [chatProvider, hermesProvider, hermesProvider] });
    expect(AgentSettingsViewSchema.safeParse(view).success).toBe(false);
  });

  it("caps the combined provider model catalog at 256 models", () => {
    const models = Array.from({ length: 128 }, (_, index) => ({
      ...hermesProvider.models[0],
      id: `model-${index}`,
    }));
    const view = makeView({
      providers: [
        chatProvider,
        { ...hermesProvider, models },
        { ...hermesProvider, id: "second", models },
      ],
    });
    expect(AgentSettingsViewSchema.safeParse(view).success).toBe(false);
  });

  it("parses a legacy gateway response through the compatibility schema", () => {
    const legacy = {
      identity: { name: "Matrix Owner" },
      kernel: { model: "claude-opus-4-6", effort: "high" },
      availableModels: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" }],
      availableEfforts: ["low", "medium", "high", "max"],
      defaults: { model: "claude-opus-4-6", effort: "high" },
    };
    expect(AgentSettingsCompatibleViewSchema.parse(legacy)).toEqual(legacy);
  });

  it("keeps legacy model and effort-only updates valid", () => {
    expect(AgentSettingsUpdateSchema.parse({ model: "claude-opus-4-6", effort: "high" }))
      .toEqual({ model: "claude-opus-4-6", effort: "high" });
  });

  it("rejects revision-only no-op updates", () => {
    expect(AgentSettingsUpdateSchema.safeParse({ revision: 4 }).success).toBe(false);
  });

  it("requires revision for extended runtime/provider updates", () => {
    expect(AgentSettingsUpdateSchema.safeParse({ runtime: "openclaw" }).success).toBe(false);
  });

  it("rejects non-HTTPS provider base URLs", () => {
    const update = {
      provider: "custom",
      messagingModel: "custom-model",
      baseUrl: "http://models.example.com/v1",
      revision: 4,
    };
    expect(AgentSettingsUpdateSchema.safeParse(update).success).toBe(false);
  });
});
