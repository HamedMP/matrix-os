// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "https://gateway.test", getGatewayWs: () => "wss://gateway.test/ws" }));
vi.mock("@/lib/websocket-auth", () => ({ buildAuthenticatedWebSocketUrl: () => new Promise(() => {}) }));
import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";

const account = { id: "work", service: "gmail", account_label: "Work", account_email: "work@example.invalid", status: "active", connected_at: "2026-10-01T10:00:00.000Z" };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["timestamp", "status"])("completes same-ID Gmail reauthorization after %s recovery", async recovery => {
  const before = recovery === "status" ? { ...account, status: "expired" } : account;
  const after = recovery === "timestamp" ? { ...account, connected_at: "2026-10-08T10:00:00.000Z" } : account;
  let poll!: () => Promise<void>;
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (delay === 2_000) poll = callback as () => Promise<void>;
    return setInterval(callback, delay, ...args);
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/available") ? [{ id: "gmail", name: "Gmail", category: "google", authType: "oauth" }]
      : url.endsWith("/connection-options") ? { methods: ["matrix", "pipedream"], defaultMethod: "matrix" }
      : url.endsWith("/connect") ? { url: "https://app.matrix-os.com/auth/gmail?state=opaque" }
      : url.endsWith("/sync") ? { synced: 0, services: [after] } : [before];
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue({ location: { href: "about:blank" }, close: vi.fn() } as unknown as Window);
  render(<IntegrationsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Add another Gmail account" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect with Matrix (internal preview)" }));
  await waitFor(() => expect(poll).toBeTypeOf("function"));
  expect((screen.getByRole("button", { name: "Add another Gmail account" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => poll());
  expect((screen.getByRole("button", { name: "Add another Gmail account" }) as HTMLButtonElement).disabled).toBe(false);
});
