// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice";
import { createCanonicalComposerSelection } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";

afterEach(cleanup);
function heldCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  catalog.instances = [{ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI",
    connectionLabel: "Matrix AI", connectionState: "credit_reserved", availability: "unavailable",
    defaultSelection: undefined, models: [{ ...base.models[0]!, id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5", availability: "unavailable" }],
    setupActions: [{ id: "settings", kind: "open_settings", label: "Agents & providers" }] }];
  return CanonicalProviderCatalogSchema.parse(catalog);
}

it("shows authorized held models without executable choices or a new Chat default", () => {
  const catalog = heldCatalog();
  const select = vi.fn();
  const setup = vi.fn();
  expect(deriveCanonicalProviderChoices(catalog)).toEqual([]);
  expect(createCanonicalComposerSelection(catalog)).toBeNull();
  render(<CompactChatProviderChoices catalog={catalog} choices={[]} selected={null} onSelect={select} onSetupAction={setup} />);
  expect(screen.getByRole("button", { name: "Matrix AI agent, Matrix AI credit reserved" })).toBeEnabled();
  const option = screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" });
  expect(option).toBeDisabled();
  expect(option).toHaveAttribute("aria-selected", "false");
  fireEvent.click(option);
  fireEvent.keyDown(option, { key: "Enter" });
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Agents & providers" }));
  expect(setup).toHaveBeenCalledExactlyOnceWith(catalog.instances[0], catalog.instances[0]!.setupActions[0]);
});

it("searches disabled models and preserves the bound Chat identity", () => {
  const catalog = heldCatalog();
  const select = vi.fn();
  render(<CompactChatProviderChoices catalog={catalog} choices={[]} selected={{ instanceId: "matrix_pi_default", modelId: "anthropic:claude-sonnet-5" }}
    lockedInstanceId="matrix_pi_default" onSelect={select} />);
  const option = screen.getByRole("option");
  expect(option).toHaveAttribute("aria-selected", "true");
  expect(option).toBeDisabled();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sonnet" } });
  expect(screen.getByRole("option")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unauthorized-model" } });
  expect(screen.queryByRole("option")).toBeNull();
  expect(screen.getByText("No matching models.")).toBeVisible();
  expect(select).not.toHaveBeenCalled();
});

it("retains funding-specific status in the Electron closed bound picker", () => {
  render(<ProviderModelPicker catalog={heldCatalog()} selection={{ instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5",
    options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(within(trigger).getByText("Credit reserved")).toBeVisible();
  expect(trigger.title).toContain("Credit reserved");
  expect(trigger.title).not.toContain("Unavailable");
  expect(trigger).toHaveAttribute("data-provider-instance", "matrix_pi_default");
  expect(trigger).toHaveAttribute("data-model", "anthropic:claude-sonnet-5");
});

it("does not let a retained executable choice override the newly blocked server catalog", () => {
  const catalog = heldCatalog();
  const prior = structuredClone(catalog);
  prior.instances[0]!.availability = "available";
  prior.instances[0]!.connectionState = "ready";
  prior.instances[0]!.models[0]!.availability = "available";
  const select = vi.fn();
  render(<CompactChatProviderChoices catalog={catalog} choices={deriveCanonicalProviderChoices(prior)} selected={null} onSelect={select} />);
  const option = screen.getByRole("option");
  expect(option).toBeDisabled();
  fireEvent.click(option);
  expect(select).not.toHaveBeenCalled();
});
it("does not assign another model's funding reason to a revoked saved Electron model", () => {
  render(<ProviderModelPicker catalog={heldCatalog()} selection={{ instanceId: "matrix_pi_default", model: "anthropic:revoked-model",
    options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(within(trigger).getByText("Unavailable")).toBeVisible();
  expect(within(trigger).queryByText("Credit reserved")).toBeNull();
  expect(trigger).toHaveAttribute("data-model", "anthropic:revoked-model");
});
it("reports disabled peer model availability independently from its healthy instance", () => {
  const catalog = heldCatalog();
  const instance = catalog.instances[0]!;
  instance.availability = "available";
  instance.connectionState = "ready";
  instance.models[0]!.availability = "available";
  instance.models.push({ ...instance.models[0]!, id: "cloudflare:@cf/zai-org/glm-5.3-flash", displayName: "GLM 5.3 Flash", availability: "unavailable" });
  const select = vi.fn();
  render(<CompactChatProviderChoices catalog={catalog} choices={deriveCanonicalProviderChoices(catalog)} selected={null} onSelect={select} />);
  const blocked = screen.getByRole("option", { name: "GLM 5.3 Flash via Matrix AI" });
  expect(blocked).toBeDisabled();
  expect(within(blocked).getByText(/Model unavailable/)).toBeVisible();
  expect(within(blocked).queryByText(/ · Available$/)).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" }));
  expect(select).toHaveBeenCalledTimes(1);
});
