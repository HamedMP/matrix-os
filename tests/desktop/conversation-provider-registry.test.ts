import { describe, expect, it, vi } from "vitest";
import {
  createConversationProviderRegistry,
} from "../../desktop/src/renderer/src/components/conversation/provider-registry";

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
