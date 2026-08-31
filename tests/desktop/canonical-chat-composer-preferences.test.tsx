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
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    await screen.findByRole("textbox", { name: "Start a chat" });
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("full access");
  });
});
