// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../home/app-templates/connected-starter/src/App";
import { ImportDialog } from "../../home/app-templates/connected-starter/src/ImportDialog";
import catalog from "../../home/system/app-gallery.json";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
const app = catalog.apps.find(a => a.id === "subscriptions") as Definition;
const account = { id: "gmail_work", service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active" };
const snapshot = { appId: "subscriptions", runId: "d38f91fb-8ac6-421d-9476-7451e3137321", status: "running", stage: "reading", sources: [{ service: "gmail", label: "Work", email: "work@example.test", status: "running" }], steps: 2, added: 0, updated: 0, skipped: 0, keepUpdated: true, startedAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:01Z", lastCheckedAt: null, nextCheckAt: null, error: null };
afterEach(() => { cleanup(); delete window.MatrixOS; vi.useRealTimers(); });
describe("shared app sync experience", () => {
  it("awaits actual acceptance, submits selected identities and never uses the chat handoff", async () => {
    let accept!: (value: unknown) => void;
    const gatewayFetch = vi.fn(() => new Promise(resolve => { accept = resolve; })), generate = vi.fn();
    window.MatrixOS = { integrations: async () => [account], gatewayFetch, generate };
    render(<ImportDialog app={app} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /work@example.test/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start import" }));
    expect(screen.getByRole("button", { name: "Starting import…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Request sent to Matrix")).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    const input = JSON.parse(gatewayFetch.mock.calls[0][1]!.body as string);
    expect(input).toMatchObject({ accounts: [{ connectionId: "gmail_work", expectedEmail: "work@example.test" }], keepUpdated: true });
    accept(snapshot);
    expect(await screen.findByRole("progressbar", { name: "Accounts processed" })).toBeTruthy();
  });
  it("preserves choices and offers retry when starting fails", async () => {
    window.MatrixOS = { integrations: async () => [account], gatewayFetch: vi.fn().mockRejectedValue(new Error("offline")) };
    render(<ImportDialog app={app} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /work@example.test/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start import" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /work@example.test/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Start import" }).hasAttribute("disabled")).toBe(false);
  });
  it("restores a running import after reopening and refreshes records after completion", async () => {
    let current = snapshot;
    const find = vi.fn(async () => []);
    window.MatrixOS = { db: { find, insert: vi.fn(), update: vi.fn() }, integrations: async () => [account], gatewayFetch: vi.fn(async () => current) };
    render(<App app={app} />);
    expect(await screen.findByText("Importing your subscriptions")).toBeTruthy();
    const initialReads = find.mock.calls.length;
    current = { ...snapshot, status: "complete", stage: "finished", sources: [{ ...snapshot.sources[0], status: "complete" }], added: 2, lastCheckedAt: "2026-10-19T00:00:03Z", nextCheckAt: "2026-10-19T00:15:03Z" } as typeof snapshot;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("2 new · 0 updated")).toBeTruthy();
    await waitFor(() => expect(find.mock.calls.length).toBeGreaterThan(initialReads));
    expect(screen.getByText(/Checks every minute/)).toBeTruthy();
  });
});
