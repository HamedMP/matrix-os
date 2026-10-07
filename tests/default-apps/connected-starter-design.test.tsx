// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Views from "../../home/app-templates/connected-starter/src/Views";
import Sidebar from "../../home/app-templates/connected-starter/src/Sidebar";
import RevenueTrend from "../../home/app-templates/connected-starter/src/views/RevenueTrend";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import catalog from "../../home/system/app-gallery.json";
afterEach(cleanup);
function record(id: string, fields: OwnerRecord["fields"]): OwnerRecord {
  return { id, fields, accounts: [], sources: [], manualFields: [], scope: "personal", updatedAt: "" };
}
function props(id: string, records: OwnerRecord[]) {
  return { app: catalog.apps.find(app => app.id === id) as Definition, records, onEdit: vi.fn(), onEvidence: vi.fn(), onAdd: vi.fn(), onSave: vi.fn(async () => {}) };
}
describe("connected app subject-specific interactions", () => {
  it("keeps the filter panel open while clearing a search", () => {
    function Filters() {
      const [query, setQuery] = useState("Lisbon");
      return createElement(Sidebar, { ...props("atlas", []), count: 0, canUseRecords: true, canImport: true, accounts: [], query, setQuery, scope: "all", setScope: vi.fn(), account: "", setAccount: vi.fn(), onImport: vi.fn() });
    }
    render(createElement(Filters));
    const panel = screen.getByText("Filters & connections").closest("details")!;
    expect(panel.open).toBe(true);
    fireEvent.change(screen.getByLabelText("Search records"), { target: { value: "" } });
    expect(panel.open).toBe(true);
    expect(screen.getByRole("button", { name: "Connect & import" })).toBeTruthy();
  });
  it("positions revenue dots at the centers of the shared label columns", () => {
    const { container } = render(createElement(RevenueTrend, { points: [["2026-08", 20], ["2026-09", 40]], max: 40 }));
    expect([...container.querySelectorAll("circle")].map(dot => Number(dot.getAttribute("cx")))).toEqual([150, 450]);
  });
  it("selects a journey from the destination canvas, preserves actions and falls back when a filter removes it", () => {
    const first = record("a", { title: "Autumn in Lisbon", destination: "Lisbon", flight: "TP123", date: "2026-10-08" });
    const second = record("b", { title: "Northern weekend", destination: "Copenhagen", flight: "SK456" });
    const p = props("atlas", [first, second]);
    const view = render(createElement(Views, p));
    fireEvent.click(screen.getByRole("button", { name: "View Northern weekend" }));
    const detail = screen.getByRole("region", { name: "Selected journey" });
    expect(within(detail).getByText("SK456")).toBeTruthy();
    expect(within(detail).queryByText("TP123")).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    expect(p.onEdit).toHaveBeenCalledWith(second);
    view.rerender(createElement(Views, { ...p, records: [first] }));
    expect(within(screen.getByRole("region", { name: "Selected journey" })).getByText("TP123")).toBeTruthy();
  });
  it("keeps unrecognized destinations selectable without inventing map coordinates", () => {
    render(createElement(Views, props("atlas", [record("x", { title: "A place to confirm", destination: "Mystery island" })])));
    expect(screen.getByText("Location not mapped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Map: Mystery island" })).toBeNull();
    expect(screen.getByRole("button", { name: "View A place to confirm" })).toBeTruthy();
  });
  it("uses map controls for known destinations and treats inherited object names as unlocated", () => {
    const p = props("atlas", [record("a", { title: "Lisbon", destination: "Lisbon", flight: "TP100" }), record("b", { title: "London", destination: "London", flight: "BA200" }), record("c", { title: "Unknown", destination: "constructor" })]);
    render(createElement(Views, p));
    fireEvent.click(screen.getByRole("button", { name: "Map: London" }));
    expect(within(screen.getByRole("region", { name: "Selected journey" })).getByText("BA200")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Map: constructor" })).toBeNull();
  });
  it("reads meeting preparation and next steps in a separate document, without truncating notes", () => {
    const p = props("meeting-briefs", [record("a", { title: "Design review", brief: "Discuss the travel canvas", actions: "Review phone flow", notes: "Keep the sources visible" }), record("b", { title: "Delivery sync", brief: "Check project ownership", actions: "Assign a reviewer" })]);
    render(createElement(Views, p));
    fireEvent.click(screen.getByRole("button", { name: "Read Delivery sync" }));
    const document = screen.getByRole("article", { name: "Meeting preparation" });
    expect(within(document).getByText("Check project ownership")).toBeTruthy();
    expect(within(document).getByText("Assign a reviewer")).toBeTruthy();
    expect(within(document).queryByText("Discuss the travel canvas")).toBeNull();
    fireEvent.click(within(document).getByRole("button", { name: "Manual entry" }));
    expect(p.onEvidence).toHaveBeenCalledWith(p.records[1]);
  });
  it("retains active and cancelled subscription rows without combining cadence or currencies", () => {
    const p = props("subscriptions", [record("a", { title: "Design tool", amount: 20, currency: "EUR", cadence: "Monthly", status: "Active" }), record("b", { title: "Annual archive", amount: 100, currency: "USD", cadence: "Annual", status: "Cancelled" })]);
    render(createElement(Views, p));
    const rows = screen.getByRole("list", { name: "Subscription commitments" });
    expect(within(rows).getByText("Design tool")).toBeTruthy();
    expect(within(rows).getByText("Annual archive")).toBeTruthy();
    expect(within(rows).getByText("Cancelled")).toBeTruthy();
    fireEvent.click(within(rows).getAllByRole("button", { name: "Edit" })[1]);
    expect(p.onEdit).toHaveBeenCalledWith(p.records[1]);
  });
  it("keeps spending categories currency-safe and excludes unpaid and refunded records", () => {
    const p = props("folio", [record("a", { title: "Lunch", category: "Food", amount: 20, currency: "EUR", status: "Paid" }), record("b", { title: "Work flight", category: "Travel", amount: 500, currency: "USD", status: "Paid" }), record("c", { title: "Unpaid flight", category: "Travel", amount: 900, currency: "EUR", status: "Unpaid" }), record("d", { title: "Refund", category: "Refund", amount: 5, currency: "EUR", status: "Refund" })]);
    render(createElement(Views, p));
    const breakdown = screen.getByRole("region", { name: "Settled spending categories" });
    expect(within(breakdown).getByText("Food")).toBeTruthy();
    expect(within(breakdown).queryByText("Travel")).toBeNull();
    expect(within(breakdown).queryByText("Refund")).toBeNull();
    fireEvent.change(screen.getByLabelText("Chart currency"), { target: { value: "USD" } });
    expect(within(breakdown).getByText("Travel")).toBeTruthy();
    expect(within(breakdown).queryByText("Food")).toBeNull();
  });
  it("keeps filters and import available in the compact controls panel", () => {
    const p = { ...props("atlas", []), count: 0, canUseRecords: true, canImport: true, accounts: [], query: "", setQuery: vi.fn(), scope: "all" as const, setScope: vi.fn(), account: "", setAccount: vi.fn(), onImport: vi.fn() };
    render(createElement(Sidebar, p));
    fireEvent.click(screen.getByText("Filters & connections"));
    fireEvent.change(screen.getByLabelText("Search records"), { target: { value: "Lisbon" } });
    expect(p.setQuery).toHaveBeenCalledWith("Lisbon");
    fireEvent.click(screen.getByRole("button", { name: "Connect & import" }));
    expect(p.onImport).toHaveBeenCalledOnce();
  });
});
