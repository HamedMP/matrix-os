// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { ProviderModelPicker } from "../../desktop/src/renderer/src/features/chat/ProviderModelPicker";
import { createCanonicalComposerSelection } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createClaudeModelCatalogSource } from "../../packages/gateway/src/chat/claude-model-catalog.js";

afterEach(cleanup);

it("selects the gateway's exact Fable model and preserves it when the shared picker catalog refreshes", async () => {
  let inventory = [{ value: "claude-fable-5", displayName: "Claude Fable 5" }];
  const source = createClaudeModelCatalogSource({ discover: async () => inventory });
  const service = createChatProviderCatalogService({
    codingProviders: { invalidate() {}, listProviders: async () => [{
      id: "claude", kind: "claude", displayName: "Claude Code", availability: "available",
      installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"],
      defaultMode: "default", setupActions: [],
    }] },
    agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null },
      providers: [], messaging: { runtime: "hermes", provider: null, model: null, configured: false } }),
    executableDriverKinds: ["claude_code"], codingModelCatalogSource: source,
    invalidateCodingModelCatalog: source.invalidate,
  });
  const principal = { userId: "owner_picker", source: "jwt" as const };
  const onChange = vi.fn();
  function Picker({ catalog }: { catalog: CanonicalProviderCatalog }) {
    const [selection, setSelection] = useState(() => createCanonicalComposerSelection(catalog));
    return <ProviderModelPicker catalog={catalog} selection={selection} instanceLocked onChange={(next) => {
      setSelection(next); onChange(next);
    }} />;
  }
  const view = render(<Picker catalog={await service.getCatalog(principal)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  fireEvent.click(screen.getByRole("option", { name: /Claude Fable 5/ }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "claude_code_default", model: "claude-fable-5" }));
  inventory = [...inventory, { value: "claude-fable-5-1", displayName: "Claude Fable 5.1" }];
  view.rerender(<Picker catalog={await service.refresh(principal)} />);
  expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-model"))
    .toBe("claude-fable-5");
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).toBeTruthy();
  expect(onChange).toHaveBeenCalledTimes(1);
});
