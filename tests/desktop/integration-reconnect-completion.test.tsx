// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationsSettingsSection, useIntegrations } from "../../desktop/src/renderer/src/features/integrations";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const account = { id: "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f", service: "gmail", account_label: "Work", account_email: "work@example.invalid", status: "active", connected_at: "2026-10-01T10:00:00.000Z" };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false })) });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  useIntegrations.setState(useIntegrations.getInitialState(), true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([
  ["poll", "timestamp"], ["poll", "status"], ["manual", "timestamp"], ["manual", "status"],
] as const)("completes same-ID Gmail reauthorization via %s after %s recovery", async (mode, recovery) => {
  const before = recovery === "status" ? { ...account, status: "expired" } : account;
  const after = recovery === "timestamp" ? { ...account, connected_at: "2026-10-08T10:00:00.000Z" } : account;
  const api = {
    get: vi.fn(async (path: string) => path.endsWith("/available") ? [{ id: "gmail", name: "Gmail", category: "google", actions: {} }]
      : path.endsWith("/connection-options") ? { methods: ["matrix", "pipedream"], defaultMethod: "matrix" } : [before]),
    post: vi.fn(async (path: string) => path.endsWith("/connect") ? { url: "https://app.matrix-os.com/auth/gmail?state=opaque", service: "gmail" }
      : { synced: 0, services: [after] }),
  } as unknown as ApiClient;
  useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={mode === "poll" ? [10, 10] : [60_000]} />);
  fireEvent.click(await screen.findByTestId("integration-connect-gmail"));
  fireEvent.click(await screen.findByRole("button", { name: "Connect with Matrix (internal preview)" }));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: /I've connected/i }));
  await waitFor(() => expect(screen.queryByText(/waiting for|Still waiting|Not connected yet/i)).toBeNull());
  expect(api.post).toHaveBeenCalledWith("/api/integrations/sync", {});
});
