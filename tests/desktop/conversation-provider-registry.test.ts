import { describe, expect, it, vi } from "vitest";
import {
  createConversationProviderRegistry,
} from "../../desktop/src/renderer/src/components/conversation/provider-registry";
import { createGlobalChatProviderRegistry } from
  "../../desktop/src/renderer/src/features/chat/global-chat-providers";

describe("conversation provider registry", () => {
  it("injects selection actions for arbitrary provider surfaces", async () => {
    const openWorkspace = vi.fn();
    const registry = createConversationProviderRegistry({
      selectedId: "assistant-alpha",
      providers: [
        {
          definition: {
            id: "assistant-alpha",
            label: "Assistant Alpha",
            icon: "claude",
            capabilities: ["current-conversation", "tools"],
          },
          readiness: { state: "ready" },
          onActivate: vi.fn(),
        },
        {
          definition: {
            id: "workspace-beta",
            label: "Workspace Beta",
            icon: "terminal",
            capabilities: ["project-conversation", "tools"],
          },
          readiness: { state: "ready" },
          onActivate: openWorkspace,
        },
      ],
    });

    expect(registry.selectedId).toBe("assistant-alpha");
    expect(registry.options.map((option) => option.id)).toEqual([
      "assistant-alpha",
      "workspace-beta",
    ]);
    await expect(registry.activate("workspace-beta")).resolves.toBe(true);
    expect(openWorkspace).toHaveBeenCalledOnce();
  });

  it("uses the persisted Global Chat provider and switches in the current surface", async () => {
    const selectProvider = vi.fn();
    const registry = createGlobalChatProviderRegistry({
      selectedId: "codex",
      connected: true,
      availableProviderIds: ["claude", "codex", "pi"],
      onSelectProvider: selectProvider,
    });

    expect(registry.selectedId).toBe("codex");
    expect(registry.options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "pi", label: "Pi" },
    ]);
    await expect(registry.activate("claude")).resolves.toBe(true);
    expect(selectProvider).toHaveBeenCalledWith("claude");
  });

  it("activates Pi through the same provider-neutral Global Chat seam", async () => {
    const selectProvider = vi.fn();
    const registry = createGlobalChatProviderRegistry({
      selectedId: "pi",
      connected: true,
      availableProviderIds: ["claude", "codex", "pi"],
      onSelectProvider: selectProvider,
    });

    await expect(registry.activate("pi")).resolves.toBe(true);
    expect(selectProvider).toHaveBeenCalledWith("pi");
  });

  it("fails closed when a coding-agent provider is not runtime-ready", async () => {
    const selectProvider = vi.fn();
    const registry = createGlobalChatProviderRegistry({
      selectedId: "claude",
      connected: true,
      availableProviderIds: ["claude", "codex"],
      onSelectProvider: selectProvider,
    });

    expect(registry.options.find((option) => option.id === "pi")?.readiness).toEqual({
      state: "disabled",
      reason: "Install or connect Pi before using it.",
    });
    await expect(registry.activate("pi")).resolves.toBe(false);
    expect(selectProvider).not.toHaveBeenCalled();
  });

  it("fails closed without invoking disabled or unknown provider actions", async () => {
    const disabledAction = vi.fn();
    const registry = createConversationProviderRegistry({
      selectedId: "assistant-alpha",
      providers: [{
        definition: {
          id: "assistant-alpha",
          label: "Assistant Alpha",
          icon: "claude",
          capabilities: ["current-conversation"],
        },
        readiness: { state: "disabled", reason: "Sign in first." },
        onActivate: disabledAction,
      }],
    });

    await expect(registry.activate("assistant-alpha")).resolves.toBe(false);
    await expect(registry.activate("missing-provider")).resolves.toBe(false);
    expect(disabledAction).not.toHaveBeenCalled();
  });
});
