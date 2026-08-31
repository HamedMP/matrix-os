import {
  CanonicalProviderCatalogSchema,
  type AgentProviderSummary,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSource } from "../../packages/gateway/src/agent-config/service.js";
import {
  ProviderCatalogUnavailableError,
  createChatProviderCatalogService,
  validateChatProviderSelection,
} from "../../packages/gateway/src/chat/provider-catalog.js";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import type { CodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_1", source: "jwt" };

function codingProvider(
  overrides: Partial<AgentProviderSummary> = {},
): AgentProviderSummary {
  return {
    id: "codex",
    displayName: "Codex",
    kind: "codex",
    availability: "available",
    installStatus: "installed",
    authStatus: "authenticated",
    supportedModes: ["default", "review"],
    defaultMode: "default",
    defaultModel: "gpt-5.4",
    setupActions: [{
      id: "codex_connect",
      kind: "foreground_terminal",
      label: "Connect Codex",
      command: "codex login --device-auth",
    }],
    ...overrides,
  };
}

function runtimeSource(): AgentRuntimeSource {
  return async () => ({
    runtime: {
      selected: "hermes",
      options: [{
        id: "hermes",
        displayName: "Hermes",
        installState: "installed",
        health: "healthy",
        selectionState: "active",
        configured: true,
        capabilities: ["provider_catalog", "model_selection", "authentication"],
      }, {
        id: "openclaw",
        displayName: "OpenClaw",
        installState: "installed",
        health: "stopped",
        selectionState: "available",
        configured: false,
        capabilities: ["provider_catalog", "model_selection", "authentication"],
      }],
      transition: null,
    },
    providers: [{
      id: "anthropic",
      displayName: "Anthropic",
      runtime: "hermes",
      scopes: ["messaging"],
      authKind: "api_key",
      supportedAuthKinds: ["api_key"],
      models: [{
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        capabilities: ["tools", "vision", "reasoning"],
        efforts: ["low", "high"],
        available: true,
      }],
      authStatus: { state: "ready", authenticated: true, action: "none" },
    }],
    messaging: {
      runtime: "hermes",
      provider: "anthropic",
      model: "claude-opus-4-6",
      configured: true,
    },
  });
}

function codingRegistry(
  providers: AgentProviderSummary[] = [codingProvider()],
): CodingAgentProviderRegistry {
  return {
    listProviders: vi.fn(async () => providers),
    invalidate: vi.fn(),
  };
}

describe("canonical Chat Provider catalog", () => {
  it("preserves namespaced system model ids in the canonical catalog", async () => {
    const source: AgentRuntimeSource = async () => {
      const snapshot = await runtimeSource()();
      return {
        ...snapshot,
        providers: [...snapshot.providers, {
          id: "nous",
          displayName: "Nous Portal",
          runtime: "hermes",
          scopes: ["messaging"],
          authKind: "oauth_login",
          supportedAuthKinds: ["oauth_login"],
          models: [{
            id: "anthropic/claude-opus-5",
            displayName: "Claude Opus 5",
            capabilities: ["tools", "reasoning"],
            efforts: ["high"],
            available: true,
          }],
          authStatus: { state: "ready", authenticated: true, action: "none" },
        }],
        messaging: {
          runtime: "hermes",
          provider: "nous",
          model: "anthropic/claude-opus-5",
          configured: true,
        },
      };
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry(),
      agentRuntimeSource: source,
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "nous:anthropic/claude-opus-5" }),
    ]));
    expect(hermes.defaultSelection).toEqual({
      instanceId: "hermes_default",
      model: "nous:anthropic/claude-opus-5",
    });
  });

  it("projects system and coding runtimes through one bounded catalog", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry(),
      agentRuntimeSource: runtimeSource(),
      skillsSource: () => [{ name: "matrix-review", description: "Review Matrix changes" }],
    });

    const catalog = await service.getCatalog(principal);

    expect(CanonicalProviderCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.drivers.map((driver) => [driver.kind, driver.capabilityClass]))
      .toEqual([
        ["hermes", "system_agent"],
        ["openclaw", "system_agent"],
        ["codex", "coding_agent"],
        ["claude_code", "coding_agent"],
        ["opencode", "coding_agent"],
        ["pi", "coding_agent"],
      ]);
    expect(catalog.instances.find((instance) => instance.id === "hermes_default"))
      .toMatchObject({
        driverKind: "hermes",
        availability: "available",
        setupActions: [{
          id: "hermes_settings",
          kind: "open_settings",
          label: "Configure Hermes",
        }],
        defaultSelection: {
          instanceId: "hermes_default",
          model: "anthropic:claude-opus-4-6",
        },
      });
    expect(catalog.instances.find((instance) => instance.id === "codex_default"))
      .toMatchObject({
        driverKind: "codex",
        availability: "available",
        models: [{ id: "gpt-5.4" }],
        setupActions: [{ id: "codex_connect" }],
        skills: [{ id: "matrix-review", invocation: "/matrix-review" }],
      });
    expect(catalog.instances.find((instance) => instance.id === "openclaw_default"))
      .toMatchObject({
        availability: "unavailable",
        models: [],
        setupActions: [{
          id: "openclaw_settings",
          kind: "open_settings",
          label: "Configure OpenClaw",
        }],
      });
    expect(catalog.instances.filter((instance) =>
      ["claude_code", "opencode", "pi"].includes(instance.driverKind)
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "claude_code_default",
        availability: "setup_required",
        models: [],
        setupActions: expect.arrayContaining([
          expect.objectContaining({ id: "claude_install", kind: "foreground_terminal" }),
          expect.objectContaining({ id: "claude_connect", kind: "foreground_terminal" }),
        ]),
      }),
      expect.objectContaining({
        id: "opencode_default",
        availability: "setup_required",
        models: [],
        setupActions: expect.arrayContaining([
          expect.objectContaining({ id: "opencode_install", kind: "foreground_terminal" }),
          expect.objectContaining({ id: "opencode_connect", kind: "foreground_terminal" }),
        ]),
      }),
      expect.objectContaining({
        id: "pi_default",
        availability: "setup_required",
        models: [],
        setupActions: expect.arrayContaining([
          expect.objectContaining({ id: "pi_install", kind: "foreground_terminal" }),
          expect.objectContaining({ id: "pi_connect", kind: "foreground_terminal" }),
        ]),
      }),
    ]));
    expect(new Set(catalog.instances.map((instance) => instance.catalogRevision)))
      .toEqual(new Set([catalog.revision]));
  });

  it("fails a system harness closed until its own provider authentication is configured", async () => {
    const source: AgentRuntimeSource = async () => {
      const snapshot = await runtimeSource()();
      return {
        ...snapshot,
        messaging: {
          ...snapshot.messaging,
          configured: false,
        },
      };
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry(),
      agentRuntimeSource: source,
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.availability).toBe("auth_required");
    expect(hermes.defaultSelection).toBeUndefined();
    expect(hermes.models).toEqual([]);
    expect(hermes.options).toEqual([]);
  });

  it("restores visible Terminal setup actions when an unavailable coding Provider omits them", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({
        id: "opencode",
        displayName: "OpenCode",
        kind: "opencode",
        availability: "unavailable",
        installStatus: "installed",
        authStatus: "unknown",
        defaultModel: undefined,
        setupActions: [],
      })]),
      agentRuntimeSource: runtimeSource(),
    });

    const opencode = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "opencode_default")!;

    expect(opencode.models).toEqual([]);
    expect(opencode.setupActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "opencode_install", kind: "foreground_terminal" }),
      expect.objectContaining({ id: "opencode_connect", kind: "foreground_terminal" }),
    ]));
  });

  it("does not advertise an installed harness without a canonical execution adapter", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({
        id: "opencode",
        displayName: "OpenCode",
        kind: "opencode",
        defaultModel: "provider-model",
      })]),
      agentRuntimeSource: runtimeSource(),
      executableDriverKinds: ["hermes", "codex", "claude_code"],
    });

    const catalog = await service.getCatalog(principal);
    const opencode = catalog.instances.find((instance) => instance.id === "opencode_default")!;
    const openclaw = catalog.instances.find((instance) => instance.id === "openclaw_default")!;

    expect(opencode).toMatchObject({
      availability: "unavailable",
      models: [],
      options: [],
      setupActions: [],
    });
    expect(openclaw).toMatchObject({
      availability: "unavailable",
      models: [],
      options: [],
      setupActions: [],
    });
  });

  it("uses the authenticated harness model catalog instead of a generic Provider default", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({ defaultModel: undefined })]),
      agentRuntimeSource: runtimeSource(),
      codingModelCatalogSource: vi.fn(async (provider) => provider.id === "codex" ? {
        models: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Frontier coding model",
          capabilities: ["reasoning", "tools", "vision"],
          supportsVision: true,
          supportsToolUse: true,
        }, {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          capabilities: ["reasoning", "tools", "vision"],
          supportsVision: true,
          supportsToolUse: true,
        }],
        options: [{
          id: "effort",
          label: "Reasoning",
          kind: "enum",
          values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
          defaultValue: "low",
          placement: "composer",
        }],
        defaultModel: "gpt-5.6-sol",
      } : null),
    });

    const codex = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "codex_default")!;

    expect(codex.models.map((model) => model.displayName))
      .toEqual(["GPT-5.6-Sol", "GPT-5.6-Terra"]);
    expect(codex.defaultSelection?.model).toBe("gpt-5.6-sol");
    expect(codex.options[0]).toMatchObject({ id: "effort", values: [{ value: "low" }, { value: "high" }] });
  });

  it("publishes real Claude models and only options the Claude runner accepts", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({
        id: "claude",
        displayName: "Claude",
        kind: "claude",
        defaultModel: undefined,
      })]),
      agentRuntimeSource: runtimeSource(),
    });

    const claude = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "claude_code_default")!;

    expect(claude.models.map((model) => model.id)).toEqual([
      "default",
      "opus",
      "sonnet",
    ]);
    expect(claude.models.map((model) => model.displayName)).toEqual([
      "Claude default",
      "Claude Opus",
      "Claude Sonnet",
    ]);
    expect(claude.models.some((model) => model.id === "provider-default")).toBe(false);
    expect(claude.options).toMatchObject([{
      id: "effort",
      values: [
        { value: "low" },
        { value: "medium" },
        { value: "high" },
        { value: "max" },
      ],
    }]);
    expect(claude.supports.permissionModes).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
  });

  it("hides unsupported Hermes effort and permission choices", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry(),
      agentRuntimeSource: runtimeSource(),
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.options).toEqual([]);
    expect(hermes.supports.permissionModes).toEqual(["full_access"]);
  });

  it("invalidates both live inventories before an explicit refresh", async () => {
    const registry = codingRegistry();
    const source = runtimeSource();
    source.invalidate = vi.fn();
    const service = createChatProviderCatalogService({
      codingProviders: registry,
      agentRuntimeSource: source,
    });

    await service.refresh(principal);

    expect(registry.invalidate).toHaveBeenCalledWith(principal.userId);
    expect(source.invalidate).toHaveBeenCalledOnce();
  });

  it("fails closed per readiness source without hiding the healthy domain", async () => {
    const failingRuntime: AgentRuntimeSource = async () => {
      throw new Error("secret runtime endpoint failed");
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry(),
      agentRuntimeSource: failingRuntime,
    });

    const catalog = await service.getCatalog(principal);

    expect(catalog.instances.find((instance) => instance.id === "codex_default")?.availability)
      .toBe("available");
    expect(catalog.instances.find((instance) => instance.driverKind === "hermes")?.availability)
      .toBe("unavailable");
    expect(catalog.instances.find((instance) => instance.driverKind === "openclaw")?.availability)
      .toBe("unavailable");
    expect(JSON.stringify(catalog)).not.toContain("secret runtime endpoint");
  });

  it("uses only the authenticated Hermes provider/model inventory", async () => {
    const messagingOnly: AgentRuntimeSource = async () => {
      const snapshot = await runtimeSource()(AbortSignal.timeout(1_000));
      return {
        ...snapshot,
        providers: [{
          id: "openai",
          displayName: "OpenAI",
          runtime: "hermes",
          scopes: ["messaging"],
          authKind: "api_key",
          supportedAuthKinds: ["api_key"],
          models: [{
            id: "gpt-5",
            displayName: "GPT-5",
            capabilities: ["tools", "reasoning"],
            efforts: ["high"],
            available: true,
          }],
          authStatus: { state: "ready", authenticated: true, action: "none" },
        }],
        messaging: { runtime: "hermes", provider: "openai", model: "gpt-5", configured: true },
      };
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([]),
      agentRuntimeSource: messagingOnly,
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.models.map((model) => model.id)).toEqual(["openai:gpt-5"]);
    expect(hermes.defaultSelection?.model).toBe("openai:gpt-5");
  });

  it("marks live-probed unavailable OpenCode Free models unavailable", async () => {
    const source: AgentRuntimeSource = async () => {
      const snapshot = await runtimeSource()(AbortSignal.timeout(1_000));
      return {
        ...snapshot,
        providers: [{
          id: "opencode-free",
          displayName: "OpenCode Free",
          runtime: "hermes",
          scopes: ["messaging"],
          authKind: "none",
          supportedAuthKinds: ["none"],
          models: [
            "deepseek-v4-flash-free",
            "laguna-s-2.1-free",
            "ling-3.0-flash-fin-free",
            "mimo-v2.5-free",
            "muse-spark-1.2-contributor-free",
            "nemotron-3-ultra-free",
            "nemotron-3.5-lightning-free",
          ].map((id) => ({
            id,
            displayName: id,
            capabilities: ["tools", "reasoning"],
            efforts: [],
            available: true,
          })),
          authStatus: { state: "ready", authenticated: true, action: "none" },
        }],
        messaging: {
          runtime: "hermes",
          provider: "opencode-free",
          model: "laguna-s-2.1-free",
          configured: true,
        },
      };
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([]),
      agentRuntimeSource: source,
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.models.filter((model) => model.availability === "available").map((model) => model.id))
      .toEqual([
        "opencode-free:laguna-s-2.1-free",
        "opencode-free:ling-3.0-flash-fin-free",
        "opencode-free:mimo-v2.5-free",
        "opencode-free:muse-spark-1.2-contributor-free",
        "opencode-free:nemotron-3.5-lightning-free",
      ]);
    expect(hermes.models.filter((model) => model.availability === "unavailable").map((model) => model.id))
      .toEqual([
        "opencode-free:deepseek-v4-flash-free",
        "opencode-free:nemotron-3-ultra-free",
      ]);
  });

  it("preserves a bounded provider-owned model path in the canonical catalog", async () => {
    const providerModel = "anthropic/claude-opus-4.6";
    const source: AgentRuntimeSource = async () => {
      const snapshot = await runtimeSource()(AbortSignal.timeout(1_000));
      return {
        ...snapshot,
        providers: [{
          ...snapshot.providers[0]!,
          id: "openai-codex",
          models: [{
            ...snapshot.providers[0]!.models[0]!,
            id: providerModel,
          }],
        }],
        messaging: {
          runtime: "hermes",
          provider: "openai-codex",
          model: providerModel,
          configured: true,
        },
      };
    };
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([]),
      agentRuntimeSource: source,
    });

    const hermes = (await service.getCatalog(principal)).instances
      .find((instance) => instance.id === "hermes_default")!;

    expect(hermes.models.map((model) => model.id))
      .toEqual([`openai-codex:${providerModel}`]);
    expect(hermes.defaultSelection?.model).toBe(`openai-codex:${providerModel}`);
  });

  it("keeps the active system runtime when coding inventory fails", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: {
        listProviders: async () => {
          throw new Error("secret coding inventory failure");
        },
      },
      agentRuntimeSource: runtimeSource(),
    });

    const catalog = await service.getCatalog(principal);

    expect(catalog.instances.find((instance) => instance.id === "hermes_default")?.availability)
      .toBe("available");
    expect(catalog.drivers.filter((driver) => driver.capabilityClass === "coding_agent")
      .map((driver) => driver.kind)).toEqual(["codex", "claude_code", "opencode", "pi"]);
    expect(catalog.instances.filter((instance) => instance.driverKind === "codex"
      || instance.driverKind === "claude_code"
      || instance.driverKind === "opencode"
      || instance.driverKind === "pi")
      .every((instance) => instance.availability === "unavailable")).toBe(true);
    expect(catalog.instances.filter((instance) => instance.driverKind === "codex"
      || instance.driverKind === "claude_code"
      || instance.driverKind === "opencode"
      || instance.driverKind === "pi")
      .every((instance) => instance.setupActions.length === 0)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("secret coding inventory failure");
  });

  it("names an unenumerated legacy model after its harness", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({ defaultModel: "GPT 5 default" })]),
      agentRuntimeSource: runtimeSource(),
    });

    const catalog = await service.getCatalog(principal);

    expect(catalog.instances.find((instance) => instance.id === "codex_default")?.models)
      .toMatchObject([{ id: "provider-default", displayName: "Codex default" }]);
  });

  it("advertises only attachment kinds the Pi adapter forwards", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([codingProvider({
        id: "pi",
        displayName: "Pi",
        kind: "pi",
        supportedModes: ["default"],
        defaultModel: undefined,
        setupActions: [],
      })]),
      agentRuntimeSource: runtimeSource(),
    });

    const catalog = await service.getCatalog(principal);
    const pi = catalog.instances.find((instance) => instance.id === "pi_default")!;

    expect(pi.supports.attachments).toEqual(["structured_ref"]);
    expect(validateChatProviderSelection({
      catalog,
      selection: pi.defaultSelection!,
      requirements: { attachments: ["image"] },
    })).toMatchObject({ ok: false, error: { code: "capability_mismatch" } });
  });

  it("rejects duplicate Driver projections instead of choosing one silently", async () => {
    const service = createChatProviderCatalogService({
      codingProviders: codingRegistry([
        codingProvider(),
        codingProvider({ displayName: "Second Codex" }),
      ]),
      agentRuntimeSource: runtimeSource(),
    });

    await expect(service.getCatalog(principal)).rejects
      .toBeInstanceOf(ProviderCatalogUnavailableError);
  });
});

function selectionCatalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_test",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_test",
      models: ["gpt-5.4", "gpt-5.6-sol"].map((id) => ({
        id,
        displayName: id,
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      })),
      options: [{
        id: "effort",
        label: "Reasoning",
        kind: "enum",
        values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
        defaultValue: "low",
        placement: "composer",
      }],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        attachments: ["file"],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "folder", "project"],
        interactionModes: ["default", "review"],
        permissionModes: ["supervised", "full_access"],
      },
    }],
  });
}

describe("canonical Provider selection policy", () => {
  it("allows model and option changes inside the bound Instance", () => {
    const result = validateChatProviderSelection({
      catalog: selectionCatalog(),
      boundInstanceId: "codex_default",
      selection: {
        instanceId: "codex_default",
        model: "gpt-5.6-sol",
        options: [{ id: "effort", value: "high" }],
      },
      requirements: {
        attachments: ["file"],
        interactionMode: "review",
        permissionMode: "supervised",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("returns the canonical locked error for a cross-Instance change", () => {
    const result = validateChatProviderSelection({
      catalog: selectionCatalog(),
      boundInstanceId: "another_instance",
      selection: { instanceId: "codex_default", model: "gpt-5.4" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_instance_locked",
        safeMessage: "This Chat is already bound to another Provider instance.",
        retryable: false,
        recoveryActions: ["fork_chat", "start_new_chat"],
      },
    });
  });

  it("rejects unknown models, option values, and unsupported capabilities", () => {
    expect(validateChatProviderSelection({
      catalog: selectionCatalog(),
      selection: { instanceId: "codex_default", model: "unknown" },
    })).toMatchObject({ ok: false, error: { code: "model_unavailable" } });
    expect(validateChatProviderSelection({
      catalog: selectionCatalog(),
      selection: {
        instanceId: "codex_default",
        model: "gpt-5.4",
        options: [{ id: "effort", value: "ultra" }],
      },
    })).toMatchObject({ ok: false, error: { code: "capability_mismatch" } });
    expect(validateChatProviderSelection({
      catalog: selectionCatalog(),
      selection: { instanceId: "codex_default", model: "gpt-5.4" },
      requirements: { attachments: ["image"] },
    })).toMatchObject({ ok: false, error: { code: "capability_mismatch" } });
  });
});

describe("GET /api/chat-providers", () => {
  it("returns the safe catalog for the verified principal", async () => {
    const catalog = selectionCatalog();
    const getCatalog = vi.fn(async () => catalog);
    const app = new Hono().route("/", createChatProviderRoutes({
      catalog: { getCatalog },
      getPrincipal: () => principal,
    }));

    const response = await app.request("/api/chat-providers");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(getCatalog).toHaveBeenCalledWith(principal);
  });

  it("refreshes cached provider auth when requested", async () => {
    const catalog = selectionCatalog();
    const refresh = vi.fn(async () => catalog);
    const app = new Hono().route("/", createChatProviderRoutes({
      catalog: { getCatalog: vi.fn(async () => catalog), refresh },
      getPrincipal: () => principal,
    }));

    const response = await app.request("/api/chat-providers?refresh=true");

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledWith(principal);
  });

  it("returns a generic service error when catalog projection fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono().route("/", createChatProviderRoutes({
      catalog: { getCatalog: async () => {
        throw new Error("postgres://secret-provider-catalog");
      } },
      getPrincipal: () => principal,
    }));

    const response = await app.request("/api/chat-providers");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "service_unavailable",
        safeMessage: "Provider catalog is temporarily unavailable.",
        retryable: false,
      },
    });
    expect(warning).toHaveBeenCalledWith(
      "[chat-providers] Provider catalog request failed:",
      "Error",
    );
    warning.mockRestore();
  });

  it("marks an explicitly transient catalog failure as retryable", async () => {
    const app = new Hono().route("/", createChatProviderRoutes({
      catalog: { getCatalog: async () => {
        throw new ProviderCatalogUnavailableError(true);
      } },
      getPrincipal: () => principal,
    }));

    const response = await app.request("/api/chat-providers");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "service_unavailable", retryable: true },
    });
  });

  it("does not recommend retrying a deterministic projection failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono().route("/", createChatProviderRoutes({
      catalog: { getCatalog: async () => {
        throw new ProviderCatalogUnavailableError(false);
      } },
      getPrincipal: () => principal,
    }));

    const response = await app.request("/api/chat-providers");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "service_unavailable",
        safeMessage: "Provider catalog is temporarily unavailable.",
        retryable: false,
      },
    });
    warning.mockRestore();
  });
});
