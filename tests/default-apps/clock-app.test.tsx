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
    find: vi.fn(async (table: string, opts?: { where?: Record<string, unknown>; limit?: number }) => {
      let rows = table === "zones" ? store.zones : store.alarms;
      if (opts?.where) {
        rows = rows.filter((row) =>
          Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
        );
      }
      return typeof opts?.limit === "number" ? rows.slice(0, opts.limit) : rows;
    }),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async (table: string, data: DbRow) => {
      const id = `${table}-${Math.random().toString(36).slice(2)}`;
      (table === "zones" ? store.zones : store.alarms).push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
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

function installMatrixDataBridge(data = new Map<string, unknown>()) {
  const bridge = {
    readData: vi.fn(async (key: string) => data.get(key) ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: bridge });
  return bridge;
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

  it("uses the MatrixOS data bridge when app DB is unavailable", async () => {
    const bridge = installMatrixDataBridge();
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

  it("contains invalid saved time zones to one row", async () => {
    installMatrixDb({
      zones: [{ id: "bad-zone", tz: "Invalid/Zone", position: 0 }],
      alarms: [],
    });

    render(<App />);

    expect(await screen.findByText("Invalid time zone")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove zone/i })).toBeTruthy();
  });

  it("rings alarms while another tab is active, disables one-shot alarms, and snoozes", async () => {
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
});
