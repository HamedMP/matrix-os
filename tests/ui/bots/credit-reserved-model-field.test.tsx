// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat";
import { MatrixBotModelField } from "../../../packages/ui/src/chat-agents/bots/MatrixBotModelField";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice";
afterEach(cleanup);
it("keeps the authorized Bot model visible and disabled without admitting a model change", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    availability: "unavailable", connectionState: "credit_reserved", defaultSelection: undefined,
    models: [{ ...base.models[0]!, id: selection.model, displayName: "Claude Sonnet 5", availability: "unavailable" }] }];
  const change = vi.fn();
  const view = render(<MatrixBotModelField label="Bot model" selection={null} catalog={catalog} models={[]} pending={false} onChange={change} />);
  const row = screen.getByRole("option", { name: "Claude Sonnet 5 · Matrix AI · Credit reserved" });
  expect(row).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: (row as HTMLOptionElement).value } });
  expect(change).not.toHaveBeenCalled();
  view.rerender(<MatrixBotModelField label="Bot model" selection={selection} catalog={catalog} models={[]} pending={false} onChange={change} />);
  expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue(JSON.stringify([selection.instanceId, selection.model]));
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
  expect(screen.queryByText(/saved Matrix AI model is unavailable/)).toBeNull();
});
it("does not turn retained executable Bot choices into enabled rows after the catalog blocks their route", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: selection.model, displayName: "Claude Sonnet 5" }] }];
  const retained = deriveCanonicalProviderChoices(catalog);
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.connectionState = "credit_reserved";
  catalog.instances[0]!.defaultSelection = undefined;
  catalog.instances[0]!.models[0]!.availability = "unavailable";
  const change = vi.fn();
  render(<MatrixBotModelField label="Bot model" selection={selection} catalog={catalog} models={retained} pending={false} onChange={change} />);
  const row = screen.getByRole("option", { name: "Claude Sonnet 5 · Matrix AI · Credit reserved" });
  expect(row).toBeDisabled();
  expect(screen.queryByRole("option", { name: "Claude Sonnet 5 · Matrix AI" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: (row as HTMLOptionElement).value } });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
});
