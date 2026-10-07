// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Views from "../../home/app-templates/connected-starter/src/Views";
import App from "../../home/app-templates/connected-starter/src/App";
import { Editor } from "../../home/app-templates/connected-starter/src/Dialogs";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import catalog from "../../home/system/app-gallery.json";
import {
  validateFields,
  filterRecords,
  financeSummary,
  recurringSummary,
  receivablesSummary,
  agendaGroups,
  safeUrl,
  exportRecords,
  readRecords,
} from "../../home/app-templates/connected-starter/src/model";
import { importPrompt } from "../../home/app-templates/connected-starter/src/import";
import {
  persistRecord,
  archiveRecord,
} from "../../home/app-templates/connected-starter/src/persistence";
import type {
  Definition,
  OwnerRecord,
  Database,
} from "../../home/app-templates/connected-starter/src/types";
const folio = catalog.apps.find((a) => a.id === "folio") as Definition;
const record = (
  id: string,
  fields: OwnerRecord["fields"] = {},
): OwnerRecord => ({
  id,
  fields: { title: "A receipt", ...fields },
  scope: "personal",
  accounts: [],
  sources: [],
  manualFields: [],
  updatedAt: "2026-10-06T12:00:00Z",
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.MatrixOS;
});
describe("portable connected starter", () => {
  it("supports empty actual data for every catalog view", () => {
    for (const app of catalog.apps) {
      expect(
        filterRecords([], { query: "", scope: "all", account: "" }),
      ).toEqual([]);
      expect(validateFields(app as Definition, {})).toContain(
        "Title is required",
      );
    }
    expect(financeSummary([])).toEqual({
      currencies: [],
      totals: {},
      months: {},
      weeks: {},
    });
    expect(agendaGroups([])).toEqual([]);
  });
  it("renders every useful view empty with no sample records or invented metrics", () => {
    for (const app of catalog.apps) {
      const html = renderToStaticMarkup(
        createElement(Views, {
          app: app as Definition,
          records: [],
          onEdit: () => {},
          onEvidence: () => {},
          onAdd: () => {},
          onSave: async () => {},
        }),
      );
      expect(html).toMatch(/Add|Begin focus/);
      expect(html).not.toMatch(
        /Sample receipt|London|Acme Inc|seeded|Import completed/,
      );
    }
  });
  it("shows a precise connection-readiness message and disables record/import actions without the bridge", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete window.MatrixOS;
    render(createElement(App, { app: folio }));
    expect(
      screen.getByText(
        /The app connection is not ready/,
      ),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "+ Add expense",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Connect & import",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("validates unknown numbers, currencies, enums and real calendar dates", () => {
    expect(
      validateFields(folio, { title: "Good", currency: "SEK", amount: null }),
    ).toEqual([]);
    expect(
      validateFields(folio, {
        title: "Good",
        currency: "fake",
        amount: -4,
        date: "2026-02-30",
        status: "Invented",
      }),
    ).toHaveLength(4);
    expect(
      validateFields(folio, {
        title: "Good",
        currency: "SEK",
        amount: "twelve",
      }),
    ).toContain("Amount must be a non-negative number");
    expect(validateFields(folio, { title: "Good", currency: "ZZZ" })).toContain(
      "Currency must be a supported three-letter code",
    );
    expect(
      validateFields(
        catalog.apps.find((a) => a.id === "analytics") as Definition,
        { title: "Observed change", value: -5 },
      ),
    ).toEqual([]);
  });
  it("counts only settled amounts, keeps currencies separate and uses dated months/weeks", () => {
    const rows = [
      record("1", {
        status: "Paid",
        amount: 10,
        currency: "SEK",
        date: "2026-10-01",
      }),
      record("2", {
        status: "Succeeded",
        amount: 3,
        currency: "EUR",
        date: "2026-10-02",
      }),
      record("3", { status: "Unpaid", amount: 70, currency: "SEK" }),
      record("4", { status: "Refund", amount: 6, currency: "SEK" }),
      record("5", { status: "Paid", amount: null, currency: "SEK" }),
      record("6", { status: "Paid", amount: 50, currency: "ZZZ" }),
    ];
    const summary = financeSummary(rows);
    expect(summary.totals).toEqual({ EUR: 3, SEK: 10 });
    expect(summary.months.SEK).toEqual({ "2026-10": 10 });
    expect(Object.values(summary.weeks.SEK)).toEqual([10]);
  });
  it("keeps active recurring costs separated by currency and cadence rather than settled spending", () => {
    const rows = [
      record("m", {
        status: "Active",
        amount: 20,
        currency: "SEK",
        cadence: "Monthly",
      }),
      record("a", {
        status: "Active",
        amount: 100,
        currency: "SEK",
        cadence: "Annual",
      }),
      record("e", {
        status: "Active",
        amount: 5,
        currency: "EUR",
        cadence: "Monthly",
      }),
      record("c", {
        status: "Cancelled",
        amount: 999,
        currency: "SEK",
        cadence: "Monthly",
      }),
      record("u", {
        status: "Active",
        amount: null,
        currency: "EUR",
        cadence: "Monthly",
      }),
    ];
    expect(recurringSummary(rows)).toEqual({
      SEK: { Monthly: 20, Annual: 100 },
      EUR: { Monthly: 5 },
    });
    expect(financeSummary(rows).totals).toEqual({});
  });
  it("shows sent and overdue receivables independently from settled cashflow", () => {
    const rows = [
      record("s", { status: "Sent", amount: 50, currency: "SEK" }),
      record("o", { status: "Overdue", amount: 15, currency: "EUR" }),
      record("p", { status: "Paid", amount: 10, currency: "SEK" }),
      record("d", { status: "Draft", amount: 999, currency: "SEK" }),
    ];
    expect(receivablesSummary(rows)).toEqual({
      SEK: { Sent: 50 },
      EUR: { Overdue: 15 },
    });
    expect(financeSummary(rows).totals).toEqual({ SEK: 10 });
  });
  it("uses account source pairs and scope without duplicating mixed records", () => {
    const mixed = {
      ...record("mixed"),
      accounts: [
        { service: "gmail", label: "work", email: "work@example.com" },
        { service: "gmail", label: "personal", email: "personal@example.com" },
      ],
      scope: "work" as const,
    };
    expect(
      filterRecords([mixed], {
        query: "",
        scope: "work",
        account: "gmail:work",
      }),
    ).toHaveLength(1);
    expect(
      filterRecords([mixed], {
        query: "",
        scope: "all",
        account: "gmail:personal",
      }),
    ).toHaveLength(1);
    expect(
      filterRecords([mixed], {
        query: "",
        scope: "all",
        account: "gmail:unselected",
      }),
    ).toEqual([]);
  });
  it("hides archives and rejects malformed database records", () => {
    expect(
      readRecords([
        { id: "db", payload: record("ok") },
        {
          id: "gone",
          payload: { ...record("gone"), archivedAt: "2026-10-06" },
        },
        { id: "broken", payload: { fields: [] } },
      ]).map((r) => r.id),
    ).toEqual(["ok"]);
  });
  it("bounds and deduplicates source identities and sanitizes malformed optional evidence", () => {
    const source = {
      id: "message",
      service: "gmail",
      label: "chosen",
      title: "Receipt",
      excerpt: { unsafe: true },
      url: 23,
    };
    const rows = readRecords([
      {
        id: "row",
        payload: {
          ...record("safe"),
          sources: [source, source],
          accounts: [
            { service: "gmail", label: "chosen", email: { unsafe: true } },
          ],
        },
      },
    ]);
    expect(rows[0].sources).toHaveLength(1);
    expect(rows[0].sources[0].excerpt).toBeUndefined();
    expect(rows[0].accounts[0].email).toBeUndefined();
  });
  it("groups undated agenda facts honestly and sanitizes exported spreadsheet values and links", () => {
    expect(
      agendaGroups([record("1", { date: "2026-10-22" }), record("2")]).map(
        (g) => g.date,
      ),
    ).toEqual(["2026-10-22", "Undated"]);
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("https://user:password@example.com")).toBeUndefined();
    expect(
      exportRecords(folio, [
        record("1", { title: '=HYPERLINK("evil")', currency: "SEK" }),
      ]),
    ).toContain("'=HYPERLINK");
  });
  it("requires explicit exact connected labels and bounded read-only import context", () => {
    const connection = {
      id: "chosen_connection",
      service: "gmail",
      account_label: "chosen",
      account_email: "owner@example.com",
      status: "active",
    };
    expect(() =>
      importPrompt(
        folio,
        { accounts: [], start: "2026-01-01", end: "2026-12-31", context: "" },
        [connection],
      ),
    ).toThrow("Choose");
    const prompt = importPrompt(
      folio,
      {
        accounts: [{ service: "gmail", label: "chosen", connectionId: "chosen_connection", expectedEmail: "owner@example.com" }],
        start: "2026-01-01",
        end: "2026-12-31",
        context: "",
      },
      [connection],
    );
    expect(prompt).toContain("chosen");
    expect(prompt).toContain("search");
    expect(prompt).toContain("get_message");
    expect(prompt).toContain("never send");
    expect(prompt).toContain("manualFields");
    expect(prompt).toContain("source_id");
    expect(prompt).toContain("POST /api/bridge/query");
    expect(prompt).toContain("expectedPayload");
    expect(prompt).toContain("authenticated kernel");
    expect(prompt).not.toContain("existing app data tools");
    expect(prompt).toContain("null");
    expect(() =>
      importPrompt(
        folio,
        {
          accounts: [{ service: "gmail", label: "wrong", connectionId: "chosen_connection", expectedEmail: "owner@example.com" }],
          start: "2026-01-01",
          end: "2026-12-31",
          context: "",
        },
        [connection],
      ),
    ).toThrow();
    expect(() =>
      importPrompt(
        folio,
        {
          accounts: [{ service: "gmail", label: "chosen", connectionId: "chosen_connection", expectedEmail: "owner@example.com" }],
          start: "2026-01-01",
          end: "2026-12-31",
          context: "",
        },
        [{ ...connection, status: "connected" }],
      ),
    ).toThrow();
    expect(() =>
      importPrompt(
        folio,
        {
          accounts: [{ service: "gmail", label: "chosen", connectionId: "chosen_connection", expectedEmail: "owner@example.com" }],
          start: "2020-01-01",
          end: "2026-12-31",
          context: "",
        },
        [connection],
      ),
    ).toThrow();
    const releases = catalog.apps.find(
      (a) => a.id === "releases",
    ) as Definition;
    expect(() =>
      importPrompt(
        releases,
        { accounts: [], start: "2026-01-01", end: "2026-12-31", context: "" },
        [],
      ),
    ).toThrow();
  });
  it("keeps a failed editor draft visible and reuses its stable identity on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error("offline")),
      close = vi.fn();
    render(
      createElement(Editor, {
        app: folio,
        onSave: save,
        onArchive: async () => {},
        onClose: close,
      }),
    );
    fireEvent.change(screen.getByLabelText("Title *"), {
      target: { value: "My receipt" },
    });
    fireEvent.change(screen.getByLabelText("Currency *"), {
      target: { value: "SEK" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Title *") as HTMLInputElement).value).toBe(
      "My receipt",
    );
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0][0].id).toBe(save.mock.calls[1][0].id);
  });
  it("keeps one completed focus session identity through uncertain save retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error("uncertain response"));
    const focus = catalog.apps.find((a) => a.id === "focus") as Definition;
    render(
      createElement(Views, {
        app: focus,
        records: [],
        onEdit: () => {},
        onEvidence: () => {},
        onAdd: () => {},
        onSave: save,
      }),
    );
    fireEvent.change(screen.getByLabelText("Focus task"), {
      target: { value: "Review records" },
    });
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Begin focus" }));
    await act(async () => {
      vi.advanceTimersByTime(300000);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Log completed session" }),
      );
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Log completed session" }),
      );
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0].id).toBe(save.mock.calls[1][0].id);
    expect(save.mock.calls[0][0].fields.minutes).toBe(5);
  });
  it("preserves input record on failed save or archive and omits undefined payload values", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = {
      ...record("12345678-1234-4123-8123-123456789abc"),
      rowId: "12345678-1234-4123-8123-123456789abc",
    };
    const db = {
      update: async () => {
        throw new Error("offline");
      },
    } as unknown as Database;
    await expect(persistRecord(db, original)).rejects.toThrow("Save");
    await expect(archiveRecord(db, original)).rejects.toThrow("Archive");
    expect(original.archivedAt).toBeUndefined();
    let payload: unknown;
    const ok = {
      insert: async (_table: string, row: Record<string, unknown>) => {
        payload = row.payload;
        return { id: "saved" };
      },
    } as unknown as Database;
    const saved = await persistRecord(ok, {
      ...record("new"),
      rowId: undefined,
    });
    expect(JSON.stringify(payload)).not.toContain("undefined");
    expect(saved.rowId).toBe("saved");
    expect(original.rowId).toBe(original.id);
  });
});
