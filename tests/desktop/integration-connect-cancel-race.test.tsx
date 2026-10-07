// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationsSettingsSection, useIntegrations } from "../../desktop/src/renderer/src/features/integrations";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false })) });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  useIntegrations.setState(useIntegrations.getInitialState(), true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("allows a new connect after canceling a pending request without reopening stale consent", async () => {
  const first = deferred();
  const second = deferred();
  const post = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const api = {
    baseUrl: "https://app.matrix-os.com", post,
    get: vi.fn(async (path: string) => path.endsWith("/available")
      ? [{ id: "github", name: "GitHub", category: "developer", actions: {} }]
      : path.endsWith("/connection-options") ? { methods: ["pipedream"], defaultMethod: "pipedream" } : []),
  } as unknown as ApiClient;
  useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={[60_000]} />);
  fireEvent.click(await screen.findByTestId("integration-connect-github"));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByTestId("integration-connect-github"));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  await act(async () => first.resolve({ url: "https://pipedream.com/stale-consent", service: "github" }));
  expect(window.operator.invoke).not.toHaveBeenCalled();
  await act(async () => second.resolve({ url: "https://pipedream.com/current-consent", service: "github" }));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
    url: "https://pipedream.com/current-consent",
  }));
  expect(window.operator.invoke).toHaveBeenCalledTimes(1);
});
