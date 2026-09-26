// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { SharedChatComposer } from "../../desktop/src/renderer/src/features/chat/SharedChatComposer";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";

const support = { rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
  userInput: false, worktrees: "none", resources: [], interactionModes: [], permissionModes: [] };
function catalog(revision: string, savedOff = false): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({ revision,
    drivers: [{ kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "pi_owner", driverKind: "pi", displayName: "Pi", availability: savedOff ? "unavailable" : "available",
      ...(savedOff ? { unavailabilityReason: "disabled_in_settings" } : {}), workspaceRequirement: "project_optional",
      catalogRevision: revision, models: savedOff ? [] : [{ id: "model", displayName: "Owner model", availability: "available",
        capabilities: [], supportsVision: false, supportsToolUse: false }], options: [], skills: [], commands: [], setupActions: [], supports: support,
      ...(!savedOff ? { defaultSelection: { instanceId: "pi_owner", model: "model" } } : {}) }],
  });
}
const oldCatalog = catalog("before_update");
const newCatalog = catalog("after_update", true);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function CatalogComposer({ api }: { api: { get: () => Promise<unknown> } }) {
  const state = useChatProviderCatalog(oldCatalog, { api });
  return <><output>{state.catalog.revision}</output><SharedChatComposer value="" onChange={() => undefined}
    onSubmit={() => undefined} busy={false} catalog={state.catalog}
    selection={{ instanceId: "pi_owner", model: "model", options: {}, skills: [], commands: [] }}
    onSelectionChange={() => undefined} instanceLocked={false} onProviderPickerOpen={state.refresh} /></>;
}
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
afterEach(() => cleanup());
describe("native Chat catalog freshness", () => {
  it("reloads saved-off truth when the normal picker is reopened without a cold restart", async () => {
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockResolvedValue(newCatalog);
    render(<CatalogComposer api={{ get }} />);
    await screen.findByText("before_update");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    openPicker();
    await screen.findByText("Disabled in Settings");
    expect(get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true");
    expect(screen.queryByText("Owner model")).toBeNull();
    expect(screen.queryByText("Connect Pi")).toBeNull();
    // Closing and rendering do not issue reads; one explicit reopen does.
    openPicker();
    expect(get).toHaveBeenCalledTimes(2);
    openPicker();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  it.each(["success", "error"] as const)("ignores an older %s after a newer catalog response", async (outcome) => {
    const older = deferred<CanonicalProviderCatalog>();
    const newer = deferred<CanonicalProviderCatalog>();
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    render(<CatalogComposer api={{ get }} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(async () => newer.resolve(newCatalog));
    expect(screen.getByText("after_update")).not.toBeNull();
    await act(async () => outcome === "success" ? older.resolve(oldCatalog) : older.reject(new Error("older_request_failed")));
    expect(screen.getByText("after_update")).not.toBeNull();
  });
});
