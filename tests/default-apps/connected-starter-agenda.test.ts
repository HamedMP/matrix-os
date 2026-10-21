// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agendaGroups } from "../../home/app-templates/connected-starter/src/model";
import Agenda from "../../home/app-templates/connected-starter/src/views/Agenda";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import catalog from "../../home/system/app-gallery.json";

afterEach(cleanup);

function record(id: string, date: string | null): OwnerRecord {
  return { id, fields: { title: id, date }, accounts: [], sources: [], manualFields: [], scope: "personal", updatedAt: "" };
}

describe("connected agenda grouping", () => {
  it("sorts dates chronologically, retains input order within dates and places undated records last", () => {
    const records = [record("later", "2026-10-08"), record("first", "2026-10-06"), record("invalid", "2026-02-30"), record("second", "2026-10-06"), record("missing", null)];
    expect(agendaGroups(records).map(group => ({ date: group.date, ids: group.records.map(r => r.id) }))).toEqual([
      { date: "2026-10-06", ids: ["first", "second"] },
      { date: "2026-10-08", ids: ["later"] },
      { date: "Undated", ids: ["invalid", "missing"] },
    ]);
    expect(agendaGroups([])).toEqual([]);
  });

  it("reads each date once while grouping 1,000 distinct days", () => {
    let reads = 0;
    const records = Array.from({ length: 1000 }, (_, index) => {
      const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
      const entry = record(String(index), date);
      Object.defineProperty(entry.fields, "date", { get: () => { reads++; return date; } });
      return entry;
    });
    const groups = agendaGroups(records);
    expect(groups).toHaveLength(1000);
    expect(groups.reduce((count, group) => count + group.records.length, 0)).toBe(1000);
    expect(reads).toBe(1000);
  });

  it("reuses date groups when the selected day changes and refreshes them when records change", () => {
    const date = vi.fn(() => "2026-10-06");
    const first = record("First meeting", "2026-10-06");
    Object.defineProperty(first.fields, "date", { get: date });
    const props = { app: catalog.apps.find(app => app.id === "agenda") as Definition, records: [first], onEdit: vi.fn(), onEvidence: vi.fn(), onAdd: vi.fn(), onSave: vi.fn(async () => {}) };
    const view = render(createElement(Agenda, props));
    expect(date).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Agenda date"), { target: { value: "2026-10-06" } });
    expect(screen.getByText("First meeting")).toBeTruthy();
    expect(date).toHaveBeenCalledOnce();
    view.rerender(createElement(Agenda, { ...props, records: [first, record("New meeting", "2026-10-06")] }));
    expect(screen.getByText("New meeting")).toBeTruthy();
    expect(date).toHaveBeenCalledTimes(2);
  });
});
