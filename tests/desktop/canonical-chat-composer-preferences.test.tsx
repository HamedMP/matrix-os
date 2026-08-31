// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import {
  createCanonicalChatWorkspaceClient as client,
  providerCatalog,
  snapshot,
} from "./canonical-chat-workspace-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Canonical Chat composer preferences", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  });

  beforeEach(() => {
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    useProviderPreferences.setState({
      defaultProviderId: null,
      lastComposerInstanceId: null,
      composerSelections: {},
      hydrated: true,
    });
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(cleanup);

  it("uses the last effort and permission choice as the default for a new Chat", async () => {
    const preferenceCatalog = {
      ...providerCatalog,
      instances: providerCatalog.instances.map((instance) => ({
        ...instance,
        options: [{
          id: "effort",
          label: "Reasoning",
          kind: "enum" as const,
          values: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          defaultValue: "low",
          placement: "composer" as const,
        }],
        defaultSelection: {
          instanceId: instance.id,
          model: instance.models[0]!.id,
          options: [{ id: "effort", value: "low" }],
        },
      })),
    };
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={preferenceCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "full access" }));

    expect(useProviderPreferences.getState().composerSelections.codex_fixture).toEqual({
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    await screen.findByRole("textbox", { name: "Start a chat" });
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("full access");
  });

  it("keeps the selected provider, model, effort, and permission when New chat remounts the composer", async () => {
    const codexInstance = {
      ...providerCatalog.instances[0]!,
      models: [
        providerCatalog.instances[0]!.models[0]!,
        {
          ...providerCatalog.instances[0]!.models[0]!,
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
        },
      ],
      options: [{
        id: "effort",
        label: "Reasoning",
        kind: "enum" as const,
        values: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultValue: "low",
        placement: "composer" as const,
      }],
      defaultSelection: {
        instanceId: "codex_fixture",
        model: "gpt-5.6-sol",
        options: [{ id: "effort", value: "low" }],
      },
    };
    const preferenceCatalog = {
      ...providerCatalog,
      drivers: [
        {
          kind: "hermes" as const,
          displayName: "Hermes",
          adapterVersion: "1.0.0",
          capabilityClass: "system_agent" as const,
        },
        ...providerCatalog.drivers,
      ],
      instances: [
        {
          ...codexInstance,
          id: "hermes_fixture",
          driverKind: "hermes" as const,
          displayName: "Hermes fixture",
          models: [{
            ...codexInstance.models[0]!,
            id: "openrouter:anthropic/claude-opus-4.6",
            displayName: "Hermes Opus 4.6",
          }],
          options: [],
          supports: {
            ...codexInstance.supports,
            interactionModes: ["default"],
            permissionModes: ["supervised"],
          },
          defaultSelection: {
            instanceId: "hermes_fixture",
            model: "openrouter:anthropic/claude-opus-4.6",
          },
        },
        codexInstance,
      ],
    };
    const routeClient = client();

    function Harness() {
      const [route, setRoute] = React.useState<{
        chatId?: string;
        view: "draft" | "conversation";
      }>({ chatId: snapshot.chat.id, view: "conversation" });
      return (
        <CanonicalChatWorkspace
          key={route.view}
          client={routeClient}
          projectId="matrix-os"
          projectLabel="Matrix OS"
          initialChatId={route.chatId}
          initialView={route.view}
          active
          catalog={preferenceCatalog}
          onActiveChatChanged={(chatId) => {
            if (chatId === null) setRoute({ view: "draft" });
          }}
        />
      );
    }

    render(<Harness />);

    await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-5\.6-Terra/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "full access" }));

    const selected = screen.getByRole("button", { name: "Choose model and provider" });
    expect(selected.getAttribute("data-provider-instance")).toBe("codex_fixture");
    expect(selected.getAttribute("data-model")).toBe("gpt-5.6-terra");

    fireEvent.click(selected);
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    await screen.findByRole("textbox", { name: "Start a chat" });
    const restored = screen.getByRole("button", { name: "Choose model and provider" });
    expect(restored.getAttribute("data-provider-instance")).toBe("codex_fixture");
    expect(restored.getAttribute("data-model")).toBe("gpt-5.6-terra");
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("full access");
  });
});
