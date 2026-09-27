// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

function routes(disabled: boolean): CanonicalProviderCatalog {
  const codex = providerCatalog.instances[0]!;
  return { ...providerCatalog, instances: [
    { ...codex, availability: disabled ? "unavailable" : "available", ...(disabled ? { unavailabilityReason: "disabled_in_settings" as const, models: [] } : {}) },
    { ...codex, id: "hermes_other", driverKind: "hermes", displayName: "Hermes", defaultSelection: { instanceId: "hermes_other", model: "fable" }, models: [{ ...codex.models[0]!, id: "fable", displayName: "Claude Fable" }] },
  ] };
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("retains a disabled existing Chat route and restores it when enabled without choosing another harness", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const view = render(<CanonicalChatWorkspace client={client} projectId={null} active
    initialChatId={canonicalChatRecord.chat.id} catalog={routes(true)} />);
  const picker = await screen.findByRole("button", { name: "Choose model and provider" });
  await waitFor(() => expect(picker.getAttribute("data-provider-instance")).toBe("codex_fixture"));
  expect(picker.getAttribute("data-model")).toBe("gpt-5.6-sol");
  await setSharedComposerText(screen.getByRole("textbox", { name: "Reply to chat" }), "Synthetic draft");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(send);
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.create).not.toHaveBeenCalled();
  view.rerender(<CanonicalChatWorkspace client={client} projectId={null} active
    initialChatId={canonicalChatRecord.chat.id} catalog={routes(false)} />);
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  expect(picker.getAttribute("data-provider-instance")).toBe("codex_fixture");
  expect(picker.getAttribute("data-model")).toBe("gpt-5.6-sol");
});

it.each(["disabled", "no_models"])("does not choose another harness for a bound older Chat with no saved model (%s)", async (reason) => {
  const client = createCanonicalChatWorkspaceClient();
  const record = { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, currentSelection: undefined } };
  vi.mocked(client.getDetail).mockResolvedValue({ record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities });
  render(<CanonicalChatWorkspace client={client} projectId={null} active
    initialChatId={record.chat.id} catalog={reason === "disabled" ? routes(true) : { ...routes(true), instances: routes(true).instances.map((instance) => instance.id === "codex_fixture" ? { ...instance, availability: "available" } : instance) }} />);
  await screen.findByRole("textbox", { name: "Reply to chat" });
  const picker = screen.getByRole("button", { name: "Choose model and provider" });
  expect(picker.getAttribute("data-provider-instance")).toBe("");
  await setSharedComposerText(screen.getByRole("textbox", { name: "Reply to chat" }), "Synthetic draft");
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  expect(client.admitTurn).not.toHaveBeenCalled();
});

it("keeps an explicit supported model in the bound instance when catalog refreshes remove the saved model", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const catalog: CanonicalProviderCatalog = { ...routes(false), instances: routes(false).instances.map((instance) => instance.id === "codex_fixture" ? {
    ...instance, defaultSelection: { instanceId: instance.id, model: "gpt-6-sol" },
    models: [{ ...instance.models[0]!, availability: "unavailable" }, { ...instance.models[0]!, id: "gpt-6-sol", displayName: "GPT-6-Sol" }],
  } : instance) };
  const view = render(<CanonicalChatWorkspace client={client} projectId={null} active
    initialChatId={canonicalChatRecord.chat.id} catalog={catalog} />);
  const picker = await screen.findByRole("button", { name: "Choose model and provider" });
  await waitFor(() => expect(picker.getAttribute("data-model")).toBe("gpt-5.6-sol"));
  fireEvent.click(picker);
  fireEvent.click(await screen.findByText("GPT-6-Sol"));
  await waitFor(() => expect(picker.getAttribute("data-model")).toBe("gpt-6-sol"));
  await setSharedComposerText(screen.getByRole("textbox", { name: "Reply to chat" }), "Synthetic draft");
  view.rerender(<CanonicalChatWorkspace client={client} projectId={null} active
    initialChatId={canonicalChatRecord.chat.id} catalog={{ ...catalog, revision: "fresh" }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false));
  expect(picker.getAttribute("data-model")).toBe("gpt-6-sol");
  expect(picker.getAttribute("data-provider-instance")).toBe("codex_fixture");
  expect(client.admitTurn).not.toHaveBeenCalled();
});

it.each(["auth", "runtime", "chat", "instance", "permission", "options", "unavailable"] as const)("does not retain a touched selection across invalid %s boundaries", async (boundary) => {
  const catalog: CanonicalProviderCatalog = { ...routes(false), instances: routes(false).instances.map((instance) => instance.id === "codex_fixture" ? {
    ...instance, defaultSelection: { instanceId: instance.id, model: "gpt-6-sol" },
    models: [{ ...instance.models[0]!, availability: "unavailable" }, { ...instance.models[0]!, id: "gpt-6-sol", displayName: "GPT-6-Sol" }],
  } : instance) };
  const base = { catalog, catalogReady: true, initializeImmediately: true, chatId: "chat_one",
    currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, boundInstanceId: "codex_fixture" };
  const hook = renderHook((props) => useCanonicalComposerSelection(props), { initialProps: base });
  act(() => hook.result.current.onSelectionChange({ instanceId: boundary === "instance" ? "hermes_other" : "codex_fixture",
    model: boundary === "instance" ? "fable" : "gpt-6-sol", options: boundary === "options" ? [{ id: "not_supported", value: true }] : [],
    permissionMode: boundary === "permission" ? "not_supported" : "supervised", interactionMode: "default" }));
  if (boundary === "auth") act(() => useConnection.setState({ authGeneration: 1 }));
  if (boundary === "runtime") act(() => useConnection.setState({ runtimeSlot: "other" }));
  hook.rerender({ ...base, chatId: boundary === "chat" ? "chat_two" : base.chatId,
    catalog: { ...catalog, revision: "fresh", instances: boundary === "unavailable" ? catalog.instances.map((instance) => ({ ...instance, availability: "unavailable" as const })) : catalog.instances } });
  expect(hook.result.current.selection?.instanceId).toBe("codex_fixture");
  expect(hook.result.current.selection?.model).toBe("gpt-5.6-sol");
});

it.each([false, true])("retains an explicit cross-instance choice in an unbound draft after refresh (saved route disabled: %s)", (disabled) => {
  const catalog = routes(disabled);
  const base = { catalog, catalogReady: true, initializeImmediately: true, chatId: "draft_chat",
    currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, boundInstanceId: undefined };
  const hook = renderHook((props) => useCanonicalComposerSelection(props), { initialProps: base });
  act(() => hook.result.current.onSelectionChange({ instanceId: "hermes_other", model: "fable", options: [], permissionMode: "supervised", interactionMode: "default" }));
  hook.rerender({ ...base, catalog: { ...catalog, revision: "refresh" } });
  expect(hook.result.current.selection?.instanceId).toBe("hermes_other");
  expect(hook.result.current.selection?.model).toBe("fable");
});


it.each(["chat", "auth", "runtime"] as const)("resets explicit unbound draft instance intent across %s changes", (boundary) => {
  const catalog = routes(false);
  const base = { catalog, catalogReady: true, initializeImmediately: true, chatId: "draft_one",
    currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, boundInstanceId: undefined };
  const hook = renderHook((props) => useCanonicalComposerSelection(props), { initialProps: base });
  act(() => hook.result.current.onSelectionChange({ instanceId: "hermes_other", model: "fable", options: [], permissionMode: "supervised", interactionMode: "default" }));
  if (boundary === "auth") act(() => useConnection.setState({ authGeneration: 1 }));
  if (boundary === "runtime") act(() => useConnection.setState({ runtimeSlot: "other" }));
  hook.rerender({ ...base, chatId: boundary === "chat" ? "draft_two" : base.chatId, catalog: { ...catalog, revision: "refresh" } });
  expect(hook.result.current.selection?.instanceId).toBe("codex_fixture");
});
