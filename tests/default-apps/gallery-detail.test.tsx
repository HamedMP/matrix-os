// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import GalleryDetail from "../../home/apps/app-gallery/src/GalleryDetail";
import { parseListing } from "../../home/apps/app-gallery/src/model";
import catalog from "../../home/system/app-gallery.json";

const apps = parseListing({ version: 1, apps: catalog.apps.map(app => ({ ...app, installed: false })) });
const folio = apps.find(app => app.id === "folio")!;
function props() {
  return { app: folio, connections: [], pending: false, error: "", onClose: vi.fn(), onAction: vi.fn() };
}
afterEach(cleanup);

describe("full-page Gallery details", () => {
  it("keeps catalog identity, real preview, back navigation and scoped Escape working without a modal", () => {
    const callbacks = props();
    const { container } = render(<GalleryDetail {...callbacks} />);
    expect(screen.getByRole("region", { name: folio.name })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: folio.name })).toBe(document.activeElement);
    expect(screen.getByRole("img", { name: `Screenshot of ${folio.name} with example data` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to gallery" }));
    fireEvent.keyDown(container.querySelector(".gallery-detail")!, { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Receipt Inbox")).toBeNull();
    expect(screen.getByText("Web Desktop · Web Canvas · Electron Desktop · Web Mobile")).toBeTruthy();
    expect(screen.queryByText("Desktop and mobile")).toBeNull();
  });
  it("preserves install, retry and installed launch actions and blocks all actions while pending", () => {
    const callbacks = props();
    const { rerender } = render(<GalleryDetail {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Get app" }));
    expect(callbacks.onAction).toHaveBeenCalledTimes(1);
    rerender(<GalleryDetail {...callbacks} error="Installation did not finish. Try again." />);
    expect(screen.getByRole("alert").textContent).toBe("Installation did not finish. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry installation" }));
    rerender(<GalleryDetail {...callbacks} app={{ ...folio, installed: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open app" }));
    expect(callbacks.onAction).toHaveBeenCalledTimes(3);
    rerender(<GalleryDetail {...callbacks} pending />);
    const button = screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(callbacks.onAction).toHaveBeenCalledTimes(3);
  });
  it("shows active account labels and emails without turning a connection into an import or permission grant", () => {
    const callbacks = props();
    render(<GalleryDetail {...callbacks} connections={[
      { service: "gmail", account_label: "Work", account_email: "demo@finna.ai", status: "active" },
      { service: "gmail", account_label: "Personal", account_email: "personal@example.com", status: "active" },
      { service: "gmail", account_label: "Disconnected", status: "inactive" },
    ]} />);
    const connections = screen.getByRole("region", { name: "Your connections" });
    expect(within(connections).getByText("Work (demo@finna.ai)")).toBeTruthy();
    expect(within(connections).getByText("Personal (personal@example.com)")).toBeTruthy();
    expect(within(connections).queryByText("Disconnected")).toBeNull();
    expect(within(connections).getByText("2 accounts")).toBeTruthy();
    expect(screen.getByText("Choose accounts after install")).toBeTruthy();
    expect(screen.getByText("Imports happen only when you ask Matrix and choose accounts.")).toBeTruthy();
    expect(screen.queryByText("Uploading receipts to Drive")).toBeNull();
  });
  it("distinguishes unavailable inventory, disconnected optional sources and manual entry", () => {
    const callbacks = props();
    const { rerender } = render(<GalleryDetail {...callbacks} connections={null} />);
    expect(screen.getByText("Connection inventory unavailable")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText("No connected account")).toBeNull();
    rerender(<GalleryDetail {...callbacks} app={{ ...folio, services: folio.services.map(service => ({ ...service, optional: true })) }} />);
    expect(screen.getByText("No connected account")).toBeTruthy();
    expect(screen.getByText("Optional source")).toBeTruthy();
    expect(screen.queryByText("Required permission")).toBeNull();
    rerender(<GalleryDetail {...callbacks} app={apps.find(app => app.id === "focus")!} />);
    expect(screen.getByText("No external connection required")).toBeTruthy();
    expect(screen.getByText(/Works without connections\. Add/)).toBeTruthy();
    expect(screen.queryByText("Gmail")).toBeNull();
  });
});
