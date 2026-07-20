// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/clock/src/App";

type DbRow = Record<string, unknown>;

interface FakeStore {
  zones: DbRow[];
  alarms: DbRow[];
}

function installMatrixDb(store: FakeStore) {
  const db = {
    find: vi.fn(async (table: string, opts?: { where?: Record<string, unknown>; limit?: number; orderBy?: Record<string, "asc" | "desc"> }) => {
      let rows = [...(table === "zones" ? store.zones : store.alarms)];
      if (opts?.where) {
        rows = rows.filter((row) =>
          Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
        );
      }
      if (opts?.orderBy) {
        const [key, dir] = Object.entries(opts.orderBy)[0] ?? [];
        if (key) {
          rows.sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            const cmp = typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av ?? "").localeCompare(String(bv ?? ""));
            return dir === "desc" ? -cmp : cmp;
          });
        }
      }
      return typeof opts?.limit === "number" ? rows.slice(0, opts.limit) : rows;
    }),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async (table: string, data: DbRow) => {
      const id = `${table}-${Math.random().toString(36).slice(2)}`;
      (table === "zones" ? store.zones : store.alarms).push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    }),
    bulkInsert: vi.fn(async (table: string, rows: DbRow[]) => {
      const target = table === "zones" ? store.zones : store.alarms;
      const ids = rows.map((data) => {
        const id = `${table}-${Math.random().toString(36).slice(2)}`;
        target.push({ id, created_at: new Date().toISOString(), ...data });
        return id;
      });
      return { ids };
    }),
    update: vi.fn(async (table: string, id: string, data: DbRow) => {
      const rows = table === "zones" ? store.zones : store.alarms;
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows[index] = { ...rows[index], ...data };
      return { ok: true };
    }),
    bulkUpdate: vi.fn(async (table: string, updates: Array<{ id: string; data: DbRow }>) => {
      const rows = table === "zones" ? store.zones : store.alarms;
      for (const { id, data } of updates) {
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) rows[index] = { ...rows[index], ...data };
      }
      return { ok: true };
    }),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => 0),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { db } });
  return db;
}

function installMatrixDataBridge(data = new Map<string, unknown>(), db?: unknown) {
  const bridge: Record<string, unknown> = {
    readData: vi.fn(async (key: string) => data.get(key) ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
  if (db) bridge.db = db;
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: bridge });
  return bridge as {
    readData: ReturnType<typeof vi.fn>;
    writeData: ReturnType<typeof vi.fn>;
  };
}

describe("Clock app", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom lacks AudioContext; stub so alarm/timer audio paths don't throw.
    (window as unknown as { AudioContext?: unknown }).AudioContext = vi.fn(function AudioContextMock() {
      return {
      createOscillator: () => ({ connect: () => undefined, start: () => undefined, stop: () => undefined, frequency: { value: 0 }, type: "sine" }),
      createGain: () => ({ connect: () => undefined, gain: { value: 0, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined } }),
      destination: {},
      currentTime: 0,
      close: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders the four tabs", async () => {
    installMatrixDb({ zones: [], alarms: [] });
    render(<App />);
    expect(await screen.findByRole("tab", { name: /world clock/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /alarms/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /timers?/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /stopwatch/i })).toBeTruthy();
  });

  it("shows the world-clock empty state and persists an added zone via db.insert", async () => {
    const db = installMatrixDb({ zones: [], alarms: [] });
    render(<App />);

    // Empty onboarding state visible.
    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();

    // Open the add-zone search and pick a zone (header button is first).
    fireEvent.click(screen.getAllByRole("button", { name: /add city/i })[0]);
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });

    const option = await screen.findByRole("option", { name: /tokyo/i });
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith(
        "zones",
        expect.objectContaining({ tz: "Asia/Tokyo" }),
      );
    });
  });

  it("does not insert a duplicate world-clock zone", async () => {
    const db = installMatrixDb({
      zones: [{ id: "zone-1", tz: "Asia/Tokyo", position: 0 }],
      alarms: [],
    });
    render(<App />);

    expect(await screen.findByText(/tokyo/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add city/i }));
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });

    const option = await screen.findByRole("option", { name: /tokyo/i });
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("treats concurrent duplicate zone inserts as an idempotent reload", async () => {
    const store = { zones: [] as DbRow[], alarms: [] as DbRow[] };
    const db = installMatrixDb(store);
    db.insert.mockImplementationOnce(async () => {
      store.zones.push({ id: "zone-tokyo", tz: "Asia/Tokyo", position: 0 });
      throw new Error("unique constraint violated");
    });
    render(<App />);

    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /add city/i })[0]);
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });
    const option = await screen.findByRole("option", { name: /tokyo/i });

    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("City could not be saved.")).toBeNull());
    expect(await screen.findByText(/tokyo/i)).toBeTruthy();
  });

  it("reloads saved zones after a failed optimistic zone insert", async () => {
    const store = { zones: [] as DbRow[], alarms: [] as DbRow[] };
    const db = installMatrixDb(store);
    db.insert.mockImplementationOnce(async () => {
      store.zones.push({ id: "zone-paris", tz: "Europe/Paris", position: 0 });
      throw new Error("insert failed");
    });
    render(<App />);

    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /add city/i })[0]);
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });
    const option = await screen.findByRole("option", { name: /tokyo/i });

    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("City could not be saved.")).toBeTruthy();
    expect(await screen.findByText(/paris/i)).toBeTruthy();
    expect(screen.queryByText(/tokyo/i)).toBeNull();
  });

  it("persists world-clock zone reorders with bulkUpdate", async () => {
    const db = installMatrixDb({
      zones: [
        { id: "zone-tokyo", tz: "Asia/Tokyo", position: 0 },
        { id: "zone-london", tz: "Europe/London", position: 1 },
      ],
      alarms: [],
    });
    render(<App />);

    const tokyo = (await screen.findByText(/tokyo/i)).closest("li");
    const london = (await screen.findByText(/london/i)).closest("li");
    expect(tokyo).toBeTruthy();
    expect(london).toBeTruthy();
    if (!tokyo || !london) throw new Error("Expected zone rows to render");

    fireEvent.dragStart(london);
    fireEvent.dragOver(tokyo);
    fireEvent.drop(tokyo);

    await waitFor(() => {
      expect(db.bulkUpdate).toHaveBeenCalledWith(
        "zones",
        expect.arrayContaining([
          { id: "zone-london", data: { position: 0 } },
          { id: "zone-tokyo", data: { position: 1 } },
        ]),
      );
    });
  });

  it("keeps the reorder failure banner visible after recovery reload", async () => {
    const db = installMatrixDb({
      zones: [
        { id: "zone-tokyo", tz: "Asia/Tokyo", position: 0 },
        { id: "zone-london", tz: "Europe/London", position: 1 },
      ],
      alarms: [],
    });
    db.bulkUpdate.mockRejectedValueOnce(new Error("bulk update failed"));
    render(<App />);

    const tokyo = (await screen.findByText(/tokyo/i)).closest("li");
    const london = (await screen.findByText(/london/i)).closest("li");
    if (!tokyo || !london) throw new Error("Expected zone rows to render");

    fireEvent.dragStart(london);
    fireEvent.dragOver(tokyo);
    fireEvent.drop(tokyo);

    expect(await screen.findByText("New order could not be saved.")).toBeTruthy();
  });

  it("keeps the remove-zone failure banner visible after recovery reload", async () => {
    const db = installMatrixDb({
      zones: [{ id: "zone-london", tz: "Europe/London", position: 0 }],
      alarms: [],
    });
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    render(<App />);

    expect(await screen.findByText(/london/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove london/i }));

    expect(await screen.findByText("City could not be removed.")).toBeTruthy();
    expect(await screen.findByText(/london/i)).toBeTruthy();
  });

  it("does not persist reorders while a zone id is still optimistic", async () => {
    const db = installMatrixDb({
      zones: [{ id: "zone-london", tz: "Europe/London", position: 0 }],
      alarms: [],
    });
    let resolveInsert: (() => void) | undefined;
    db.insert.mockImplementation(async (table: string) => {
      await new Promise<void>((resolve) => {
        resolveInsert = resolve;
      });
      return { id: `${table}-saved` };
    });
    render(<App />);

    expect(await screen.findByText(/london/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add city/i }));
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });
    const option = await screen.findByRole("option", { name: /tokyo/i });
    fireEvent.click(option);

    const tokyo = (await screen.findByText(/tokyo/i)).closest("li");
    const london = (await screen.findByText(/london/i)).closest("li");
    expect(tokyo).toBeTruthy();
    expect(london).toBeTruthy();
    if (!tokyo || !london) throw new Error("Expected zone rows to render");

    fireEvent.dragStart(tokyo);
    fireEvent.dragOver(london);
    fireEvent.drop(london);

    expect(db.bulkUpdate).not.toHaveBeenCalled();
    await act(async () => {
      resolveInsert?.();
      await Promise.resolve();
    });
  });

  it("uses the MatrixOS data bridge when app DB is unavailable", async () => {
    // Pre-existing user state (an empty saved list) so first-run seeding stays out of scope.
    const bridge = installMatrixDataBridge(new Map([["clock.zones", []]]));
    render(<App />);

    expect(await screen.findAllByText("Synced to device storage")).not.toHaveLength(0);
    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /add city/i })[0]);
    const search = await screen.findByPlaceholderText(/search cities/i);
    fireEvent.change(search, { target: { value: "Tokyo" } });

    const option = await screen.findByRole("option", { name: /tokyo/i });
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith(
        "clock.zones",
        expect.arrayContaining([expect.objectContaining({ tz: "Asia/Tokyo" })]),
      );
    });
  });

  it("seeds default world-clock cities on first run via the data bridge", async () => {
    const bridge = installMatrixDataBridge();
    render(<App />);

    // First run: default cities appear instead of the empty state.
    expect(await screen.findByText("Los Angeles")).toBeTruthy();
    expect(screen.getByText("London")).toBeTruthy();
    expect(screen.getByText("Berlin")).toBeTruthy();
    expect(screen.getByText("Tokyo")).toBeTruthy();

    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith(
        "clock.zones",
        expect.arrayContaining([
          expect.objectContaining({ tz: "America/Los_Angeles" }),
          expect.objectContaining({ tz: "Europe/London" }),
          expect.objectContaining({ tz: "Europe/Berlin" }),
          expect.objectContaining({ tz: "Asia/Tokyo" }),
        ]),
      );
    });
  });

  it("contains a failed first-run KV seed write and surfaces feedback", async () => {
    const bridge = installMatrixDataBridge();
    bridge.writeData.mockRejectedValueOnce(new Error("gateway unavailable"));
    render(<App />);

    expect(await screen.findByText("Los Angeles")).toBeTruthy();
    expect(await screen.findByText("Default cities could not be saved.")).toBeTruthy();
  });

  it("does not re-seed default cities after the user removed them all", async () => {
    const bridge = installMatrixDataBridge(new Map([["clock.zones", []]]));
    render(<App />);

    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    const zoneWrites = bridge.writeData.mock.calls.filter(([key]) => key === "clock.zones");
    expect(zoneWrites).toHaveLength(0);
  });

  it("does not seed defaults after a KV read failure", async () => {
    const bridge = installMatrixDataBridge();
    bridge.readData.mockRejectedValue(new Error("gateway unavailable"));
    render(<App />);

    expect(await screen.findByText(/saved cities could not be loaded/i)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    const zoneWrites = bridge.writeData.mock.calls.filter(([key]) => key === "clock.zones");
    expect(zoneWrites).toHaveLength(0);
  });

  it("seeds default cities into Postgres storage only once", async () => {
    const store: FakeStore = { zones: [], alarms: [] };
    const db = installMatrixDb(store);
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    expect(await screen.findByText("London")).toBeTruthy();
    await waitFor(() => {
      expect(store.zones.map((row) => row.tz)).toEqual([
        "America/Los_Angeles",
        "Europe/London",
        "Europe/Berlin",
        "Asia/Tokyo",
      ]);
    });
    expect(bridge.writeData).toHaveBeenCalledWith("clock.seeded-v1", true);
    expect(db.bulkInsert).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("marks pre-existing Postgres clock rows as seeded", async () => {
    const store: FakeStore = {
      zones: [{ id: "existing", tz: "Europe/Paris", position: 0 }],
      alarms: [],
    };
    const db = installMatrixDb(store);
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    expect(await screen.findByText("Paris")).toBeTruthy();
    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith("clock.seeded-v1", true);
    });
    expect(db.bulkInsert).not.toHaveBeenCalled();
  });

  it("treats a pre-existing subset of default cities as migrated user state", async () => {
    const store: FakeStore = {
      zones: [{ id: "existing", tz: "Europe/London", position: 0 }],
      alarms: [],
    };
    const db = installMatrixDb(store);
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    expect(await screen.findByText("London")).toBeTruthy();
    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith("clock.seeded-v1", true);
    });
    expect(screen.queryByText("Los Angeles")).toBeNull();
    expect(db.bulkInsert).not.toHaveBeenCalled();
  });

  it("keeps loaded Postgres cities visible when the seed marker write fails", async () => {
    const store: FakeStore = {
      zones: [{ id: "existing", tz: "Europe/Paris", position: 0 }],
      alarms: [],
    };
    const db = installMatrixDb(store);
    const bridge = installMatrixDataBridge(new Map(), db);
    bridge.writeData.mockRejectedValueOnce(new Error("gateway unavailable"));
    render(<App />);

    expect(await screen.findByText("Paris")).toBeTruthy();
    expect(screen.queryByText("Saved cities could not be loaded.")).toBeNull();
    expect(db.bulkInsert).not.toHaveBeenCalled();
  });

  it("does not mark seeding done when the default-city inserts fail", async () => {
    const store: FakeStore = { zones: [], alarms: [] };
    const db = installMatrixDb(store);
    db.bulkInsert.mockRejectedValue(new Error("database unavailable"));
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    // The empty state shows, and the marker stays unset so the next load retries.
    expect(await screen.findByText(/no cities yet/i)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    const markerWrites = bridge.writeData.mock.calls.filter(([key]) => key === "clock.seeded-v1");
    expect(markerWrites).toHaveLength(0);
  });

  it("does not mark seeding done when only part of the default set is stored", async () => {
    const store: FakeStore = { zones: [], alarms: [] };
    const db = installMatrixDb(store);
    db.bulkInsert.mockImplementation(async (_table: string, rows: DbRow[]) => {
      store.zones.push({ id: "partial", ...rows[0] });
      return { ids: ["partial"] };
    });
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    expect(await screen.findByText("Los Angeles")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    const markerWrites = bridge.writeData.mock.calls.filter(([key]) => key === "clock.seeded-v1");
    expect(markerWrites).toHaveLength(0);
  });

  it("marks seeding done when a racing tab already inserted the defaults", async () => {
    const store: FakeStore = { zones: [], alarms: [] };
    const db = installMatrixDb(store);
    // Simulate a unique-index race: the atomic insert rejects, but the rows
    // appear anyway because another tab wrote them concurrently.
    db.bulkInsert.mockImplementation(async (table: string, rows: DbRow[]) => {
      if (table === "zones") {
        store.zones.push(
          ...rows.map((data) => ({
            id: `race-${String(data.tz)}`,
            created_at: new Date().toISOString(),
            ...data,
          })),
        );
      }
      throw new Error("unique constraint");
    });
    const bridge = installMatrixDataBridge(new Map(), db);
    render(<App />);

    expect(await screen.findByText("London")).toBeTruthy();
    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith("clock.seeded-v1", true);
    });
  });

  it("contains invalid saved time zones to one row", async () => {
    installMatrixDb({
      zones: [{ id: "bad-zone", tz: "Invalid/Zone", position: 0 }],
      alarms: [],
    });

    render(<App />);

    expect(await screen.findByText("Invalid time zone")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove zone/i })).toBeTruthy();
  });

  it("rings alarms while another tab is active and re-rings snoozed one-shot alarms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 59, 59));
    const db = installMatrixDb({
      zones: [],
      alarms: [{ id: "alarm-1", time: "07:00", label: "Morning", repeat: "", enabled: true }],
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/no cities yet/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByRole("button", { name: /snooze/i })).toBeTruthy();
    expect(db.update).toHaveBeenCalledWith("alarms", "alarm-1", { enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /snooze/i }));
    expect(screen.queryByRole("button", { name: /snooze/i })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(screen.getByRole("button", { name: /snooze/i })).toBeTruthy();
  });

  it("disables all same-minute one-shot alarms when using bridge storage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 59, 59));
    const bridgeData = new Map<string, unknown>([
      // Existing (empty) world-clock list keeps first-run seeding out of this alarm test.
      ["clock.zones", []],
      [
        "clock.alarms",
        [
          { id: "alarm-1", time: "07:00", label: "Morning", repeat: "", enabled: true },
          { id: "alarm-2", time: "07:00", label: "Standup", repeat: "", enabled: true },
        ],
      ],
    ]);
    const bridge = installMatrixDataBridge(bridgeData);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByText("Synced to device storage")).not.toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });

    const lastWrite = bridge.writeData.mock.calls.at(-1);
    expect(lastWrite?.[0]).toBe("clock.alarms");
    expect(lastWrite?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alarm-1", enabled: false }),
        expect.objectContaining({ id: "alarm-2", enabled: false }),
      ]),
    );
  });

  it("uses one atomic bulk update for same-minute one-shot alarms in DB storage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 59, 59));
    const db = installMatrixDb({
      zones: [],
      alarms: [
        { id: "alarm-1", time: "07:00", label: "Morning", repeat: "", enabled: true },
        { id: "alarm-2", time: "07:00", label: "Standup", repeat: "", enabled: true },
      ],
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });

    expect(db.update).not.toHaveBeenCalled();
    expect(db.bulkUpdate).toHaveBeenCalledWith("alarms", [
      { id: "alarm-1", data: { enabled: false } },
      { id: "alarm-2", data: { enabled: false } },
    ]);
  });

  it("renders alarms in bridge order by time", async () => {
    installMatrixDb({
      zones: [],
      alarms: [
        { id: "alarm-late", time: "09:00", label: "Late", repeat: "", enabled: true },
        { id: "alarm-early", time: "06:00", label: "Early", repeat: "", enabled: true },
      ],
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /alarms/i }));

    const toggles = await screen.findAllByRole("switch");
    expect(toggles.map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      "Disable alarm 06:00",
      "Disable alarm 09:00",
    ]);
  });

  it("reloads saved alarms after a failed optimistic alarm insert", async () => {
    const store = { zones: [] as DbRow[], alarms: [] as DbRow[] };
    const db = installMatrixDb(store);
    db.insert.mockImplementationOnce(async () => {
      store.alarms.push({ id: "alarm-existing", time: "09:00", label: "Existing", repeat: "", enabled: true });
      throw new Error("insert failed");
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /alarms/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /new alarm/i })[0]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save alarm/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Alarm could not be saved.")).toBeTruthy();
    await waitFor(() => {
      expect(db.find.mock.calls.filter(([table]) => table === "alarms").length).toBeGreaterThan(1);
    });
  });

  it("keeps the alarm-toggle failure banner visible after recovery reload", async () => {
    const db = installMatrixDb({
      zones: [],
      alarms: [{ id: "alarm-1", time: "07:00", label: "Standup", repeat: "", enabled: true }],
    });
    db.update.mockRejectedValueOnce(new Error("update failed"));

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /alarms/i }));
    fireEvent.click(await screen.findByRole("switch", { name: /disable alarm 07:00/i }));

    expect(await screen.findByText("Alarm could not be updated.")).toBeTruthy();
    expect(await screen.findByRole("switch", { name: /disable alarm 07:00/i })).toBeTruthy();
  });

  it("keeps the alarm-delete failure banner visible after recovery reload", async () => {
    const db = installMatrixDb({
      zones: [],
      alarms: [{ id: "alarm-1", time: "07:00", label: "Standup", repeat: "", enabled: true }],
    });
    db.delete.mockRejectedValueOnce(new Error("delete failed"));

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /alarms/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete alarm 07:00/i }));

    expect(await screen.findByText("Alarm could not be removed.")).toBeTruthy();
    expect(await screen.findByText("07:00")).toBeTruthy();
  });

  it("clears snoozed alarms when they are disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 59, 59));
    installMatrixDb({
      zones: [],
      alarms: [{ id: "alarm-1", time: "07:00", label: "Standup", repeat: "1", enabled: true }],
    });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByRole("button", { name: /snooze/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /snooze/i }));
    fireEvent.click(screen.getByRole("tab", { name: /alarms/i }));
    fireEvent.click(screen.getByRole("switch", { name: /disable alarm 07:00/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(screen.queryByRole("button", { name: /snooze/i })).toBeNull();
  });

  it("queues alarms that fire in the same tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 59, 59));
    installMatrixDb({
      zones: [],
      alarms: [
        { id: "alarm-1", time: "07:00", label: "First", repeat: "", enabled: true },
        { id: "alarm-2", time: "07:00", label: "Second", repeat: "", enabled: true },
      ],
    });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("First")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("shows feedback for invalid custom timer input", async () => {
    installMatrixDb({ zones: [], alarms: [] });
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: /timers?/i }));
    fireEvent.change(screen.getByLabelText("Timer duration"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(await screen.findByText(/duration greater than zero/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start or pause/i })).toBeNull();
  });

  it("marks a timer done when it reaches zero", async () => {
    vi.useFakeTimers();
    installMatrixDb({ zones: [], alarms: [] });
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: /timers?/i }));
    fireEvent.change(screen.getByLabelText("Timer duration"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("starts the stopwatch and advances the displayed time", async () => {
    installMatrixDb({ zones: [], alarms: [] });
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: /stopwatch/i }));

    const readout = await screen.findByTestId("stopwatch-readout");
    expect(readout.textContent).toBe("00:00.00");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(readout.textContent).not.toBe("00:00.00");

    fireEvent.click(screen.getByRole("tab", { name: /world clock/i }));
    fireEvent.click(screen.getByRole("tab", { name: /stopwatch/i }));
    expect(readout.textContent).not.toBe("00:00.00");
  });

  it("stops the stopwatch animation loop when the panel is hidden", async () => {
    installMatrixDb({ zones: [], alarms: [] });
    vi.useFakeTimers();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: /stopwatch/i }));
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));
    expect(requestFrame).toHaveBeenCalled();
    requestFrame.mockClear();

    fireEvent.click(screen.getByRole("tab", { name: /world clock/i }));

    expect(cancelFrame).toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
