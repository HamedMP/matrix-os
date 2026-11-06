// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { desktopProviderCatalogCache, startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  for (const store of [useConnection, useCodingAgentWorkspace, useBoard]) store.setState(store.getInitialState(), true);
  resetProviderPreferences();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["codex_default", "claude_code_default"])("restores %s from a cold mixed catalog through the normal workspace cache", async rememberedId => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  for (const store of [useConnection, useCodingAgentWorkspace, useBoard]) store.setState(store.getInitialState(), true);
  useCodingAgentWorkspace.setState({ status: "ready" });
  resetProviderPreferences({ hydrated: true, lastComposerInstanceId: rememberedId, composerSelections: {
    [rememberedId]: { model: rememberedId === "codex_default" ? "gpt-5.6-sol" : "healthy-model", options: [], permissionMode: "supervised" },
  } });
  vi.stubGlobal("operator", { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => undefined) });
  const base = createCanonicalProviderCatalogFixture();
  const instance = base.instances[0]!;
  const catalog = CanonicalProviderCatalogSchema.parse({ ...base,
    drivers: [...base.drivers, { ...base.drivers[0]!, kind: "claude_code", displayName: "Claude Code" }],
    instances: [{ ...instance, id: "codex_default", displayName: "Codex", availability: "unavailable", observationState: "checking",
      unavailabilityReason: "runtime_unavailable", defaultSelection: undefined,
      models: instance.models.map(model => ({ ...model, availability: "unavailable" })) },
    { ...instance, id: "claude_code_default", driverKind: "claude_code", displayName: "Claude Code",
      models: [{ ...instance.models[0]!, id: "healthy-model", displayName: "Healthy model" }],
      defaultSelection: { instanceId: "claude_code_default", model: "healthy-model" } }],
  });
  const settings = disconnectedSnapshot();
  settings.harnesses.forEach(harness => { harness.authState = "unknown"; });
  const fetchFn = vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/api/chat-providers") return Response.json(catalog);
    if (path === "/api/ai/provider-settings") return Response.json(settings);
    throw new Error(`Unexpected fixture request ${path}`);
  });
  const api = createApiClient({ baseUrl: "https://fixture.invalid", getRuntimeSlot: () => "primary", fetchFn });
  useConnection.setState({ status: "signed-in", handle: "fixture_computer", userId: "fixture_owner", platformHost: api.baseUrl, api });
  startDesktopProviderCatalogCoordinator();
  // Deliberately omit the catalog prop: production must consume its own cold cache.
  render(<CanonicalChatWorkspace api={api} client={createCanonicalChatWorkspaceClient()} projectId={null} initialView="draft" active />);
  const composer = await screen.findByRole("textbox", { name: "Start a chat" });
  await setSharedComposerText(composer, "Keep this cold observation draft");
  await waitFor(() => expect(desktopProviderCatalogCache.getSnapshot().catalog).not.toBeNull());
  expect(desktopProviderCatalogCache.getSnapshot().lastSuccessAt).toBeNull();
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  if (rememberedId === "codex_default") {
    await waitFor(() => expect(trigger.title).toContain("Checking Codex access…"));
    expect(trigger.title).toContain("GPT-5.6-Sol");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(trigger);
    const unavailableModel = screen.getByRole("option", { name: /GPT-5.6-Sol.*Codex/ });
    expect(unavailableModel).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code agent, Available" }));
    fireEvent.click(screen.getByRole("option", { name: /Healthy model.*Claude Code/ }));
  }
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  expect(trigger.title).toContain("Healthy model");
  expect(composer.textContent).toBe("Keep this cold observation draft");
});
