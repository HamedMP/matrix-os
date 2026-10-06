// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { readRecords } from "../../home/app-templates/connected-starter/src/model";
import {
  persistRecord,
  archiveRecord,
  RecordConflictError,
} from "../../home/app-templates/connected-starter/src/persistence";
import { createElement } from "react";
import {
  Editor,
  ImportDialog,
} from "../../home/app-templates/connected-starter/src/Dialogs";
import { importPrompt } from "../../home/app-templates/connected-starter/src/import";
import catalog from "../../home/system/app-gallery.json";
import { useRecords } from "../../home/app-templates/connected-starter/src/useRecords";
import type {
  Database,
  OwnerRecord,
  Definition,
} from "../../home/app-templates/connected-starter/src/types";
const folio = catalog.apps.find((a) => a.id === "folio") as Definition;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function record(id: string): OwnerRecord {
  return {
    id,
    rowId: id,
    fields: { title: id },
    scope: "personal",
    accounts: [],
    sources: [],
    manualFields: [],
    updatedAt: "2026-10-06",
  };
}
function row(id: string, archived = false) {
  return {
    id,
    payload: {
      ...record(id),
      ...(archived ? { archivedAt: "2026-10-06" } : {}),
    },
  };
}
function bridge(find: Database["find"]): Database {
  const db = {
    find,
    insert: vi.fn(async (data: string, value: Record<string, unknown>) => ({
      id: String(value.id),
    })),
    update: vi.fn(async () => ({ ok: true })),
    compareAndSwap: vi.fn(async () => ({ ok: true })),
  };
  window.MatrixOS = { db };
  return db;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.MatrixOS;
});
describe("connected record orchestration", () => {
  it("invalidates an older read after a confirmed save and settles loading", async () => {
    const pending = deferred<Record<string, unknown>[]>();
    bridge(vi.fn(() => pending.promise));
    const { result } = renderHook(useRecords);
    const draft = { ...record("saved"), rowId: undefined };
    await act(async () => {
      await result.current.save(draft);
    });
    expect(result.current.records.map((r) => r.id)).toEqual(["saved"]);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      pending.resolve([row("stale")]);
    });
    expect(result.current.records.map((r) => r.id)).toEqual(["saved"]);
  });
  it("does not resurrect a confirmed archive from a delayed reload", async () => {
    const pending = deferred<Record<string, unknown>[]>();
    bridge(
      vi
        .fn()
        .mockResolvedValueOnce([row("gone")])
        .mockImplementation(() => pending.promise),
    );
    const { result } = renderHook(useRecords);
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    await act(async () => {
      await result.current.archive(result.current.records[0]);
    });
    expect(result.current.records).toEqual([]);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      pending.resolve([row("gone")]);
      await reload;
    });
    expect(result.current.records).toEqual([]);
  });
  it("does not surface a stale failed read after a confirmed mutation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<Record<string, unknown>[]>();
    bridge(vi.fn(() => pending.promise));
    const { result } = renderHook(useRecords);
    await act(async () => {
      await result.current.save({ ...record("saved"), rowId: undefined });
    });
    await act(async () => {
      pending.reject(new Error("Delayed failure"));
    });
    expect(result.current.error).toBe("");
    expect(result.current.records).toHaveLength(1);
  });
  it("scans beyond an archived first page to show older active records", async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => row(`archived-${i}`, true)),
      )
      .mockResolvedValueOnce([row("active")]);
    bridge(find);
    const { result } = renderHook(useRecords);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records.map((r) => r.id)).toEqual(["active"]);
    expect(find).toHaveBeenNthCalledWith(
      2,
      "records",
      expect.objectContaining({ offset: 500, limit: 500 }),
    );
    expect(result.current.limited).toBe(false);
  });
  it("caps archive scanning and explicitly reports incomplete coverage", async () => {
    const find = vi.fn(async () =>
      Array.from({ length: 500 }, (_, i) => row(`archived-${i}`, true)),
    );
    bridge(find);
    const { result } = renderHook(useRecords);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(find).toHaveBeenCalledTimes(10);
    expect(result.current.records).toEqual([]);
    expect(result.current.limited).toBe(true);
  });
});

describe("atomic record persistence", () => {
  it("uses the exact original payload guard and omits internal metadata from storage", async () => {
    const raw = row("guarded");
    const current = readRecords([raw])[0];
    const compareAndSwap = vi.fn(async () => ({ ok: true }));
    const db = { compareAndSwap } as unknown as Database;
    const saved = await persistRecord(db, {
      ...current,
      fields: { title: "Edited" },
    });
    expect(compareAndSwap).toHaveBeenCalledWith(
      "records",
      "guarded",
      raw.payload,
      { payload: expect.objectContaining({ fields: { title: "Edited" } }) },
    );
    const stored = compareAndSwap.mock.calls[0][3].payload;
    expect(stored).not.toHaveProperty("basePayload");
    expect(stored).not.toHaveProperty("rowId");
    expect(saved.basePayload).toEqual(stored);
  });
  it("rejects stale edits and stale archives rather than replacing imported evidence or resurrecting records", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = readRecords([row("stale")])[0];
    const db = {
      compareAndSwap: vi.fn(async () => ({ ok: false })),
      update: vi.fn(),
    } as unknown as Database;
    await expect(persistRecord(db, current)).rejects.toBeInstanceOf(
      RecordConflictError,
    );
    await expect(archiveRecord(db, current)).rejects.toBeInstanceOf(
      RecordConflictError,
    );
    expect(db.update).not.toHaveBeenCalled();
    expect(current.archivedAt).toBeUndefined();
  });
  it("fails closed for existing rows when the computer lacks atomic write support", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = readRecords([row("old")])[0];
    const db = { update: vi.fn() } as unknown as Database;
    await expect(persistRecord(db, current)).rejects.toThrow("Save");
    expect(db.update).not.toHaveBeenCalled();
  });
  it("recovers a lost insert response only for the same intended record", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const intended = { ...record("retry"), rowId: undefined };
    const db = {
      insert: vi.fn(async () => {
        throw new Error("Response lost");
      }),
      findOne: vi.fn(async () => ({
        id: "retry",
        payload: { ...intended, updatedAt: "earlier" },
      })),
    } as unknown as Database;
    const saved = await persistRecord(db, intended);
    expect(saved.rowId).toBe("retry");
    expect(db.findOne).toHaveBeenCalledWith("records", "retry");
    db.findOne = vi.fn(async () => row("retry-conflicting"));
    await expect(persistRecord(db, intended)).rejects.toBeInstanceOf(
      RecordConflictError,
    );
  });
  it("keeps an uncertain insert failure visible when reconciliation also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      insert: vi.fn(async () => {
        throw new Error("Offline");
      }),
      findOne: vi.fn(async () => {
        throw new Error("Offline");
      }),
    } as unknown as Database;
    await expect(
      persistRecord(db, { ...record("retry"), rowId: undefined }),
    ).rejects.toThrow("Save failed");
  });
});

describe("visible conflict and account safety", () => {
  it("keeps an edited draft open with a specific conflict explanation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const close = vi.fn();
    const save = vi.fn(async () => {
      throw new RecordConflictError();
    });
    render(
      createElement(Editor, {
        app: folio,
        record: readRecords([row("open")])[0],
        onSave: save,
        onArchive: async () => {},
        onClose: close,
      }),
    );
    const title = screen.getByLabelText("Title *");
    fireEvent.change(title, { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByLabelText("Currency *"), {
      target: { value: "SEK" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText(/This record changed since you opened it/);
    expect((title as HTMLInputElement).value).toBe("Keep this draft");
    expect(close).not.toHaveBeenCalled();
  });
  it("rejects ambiguous active labels and disables their import choices", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inventory = [
      {
        service: "gmail",
        account_label: "same",
        account_email: "one@example.test",
        status: "active",
      },
      {
        service: "gmail",
        account_label: "same",
        account_email: "two@example.test",
        status: "active",
      },
    ];
    expect(() =>
      importPrompt(
        folio,
        {
          accounts: [{ service: "gmail", label: "same" }],
          start: "2026-01-01",
          end: "2026-12-31",
          context: "",
        },
        inventory,
      ),
    ).toThrow(/unique label/);
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => inventory, generate };
    render(createElement(ImportDialog, { app: folio, onClose: () => {} }));
    await screen.findByText(/Give each account a unique label/);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Matrix to import" }),
    );
    await screen.findByRole("alert");
    expect(generate).not.toHaveBeenCalled();
  });
});
