// @vitest-environment jsdom
/**
 * The Sheets journey from spec 2710, acceptance check 4, through the real
 * App and a fake `window.MatrixOS`: Files opens `model.xlsx` with Sheets,
 * the owner edits an assumption and the projection recalculates, the
 * assistant proposes cell changes, the owner reviews old and new values,
 * accepts one and rejects the other, and saves. The saved bytes are read
 * back with the engine.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import React from "react";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openXlsx } from "../../../home/apps/_shared/office-engine/index";
import { OPEN_MARKER } from "../../../home/apps/sheets/src/agent";

const MODEL_PATH = "Documents/model.xlsx";
type Win = Window & { MatrixOS?: unknown };

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.resolve(__dirname, "../../office/fixtures", name)));
}

function bridgeError(code: string): Error {
  const error = new Error("file error") as Error & { code: string };
  error.name = "BridgeFileError";
  error.code = code;
  return error;
}

/** `window.MatrixOS` as the shell injects it, over in-memory files, a table, a key-value store and a model. */
class FakeMatrixOS {
  readonly fileStore = new Map<string, { bytes: Uint8Array; version: string }>();
  readonly writes: Array<{ path: string; ifVersion: string | null }> = [];
  readonly rows: Array<Record<string, unknown>> = [];
  readonly kv = new Map<string, unknown>();
  readonly prompts: string[] = [];
  readonly serviceCalls: string[] = [];
  replies: string[] = [];
  pendingRequest: { path: string; requestedAt: string; nonce: string } | null = null;
  private version = 0;

  put(file: string, bytes: Uint8Array): void {
    this.fileStore.set(file, { bytes, version: `v${++this.version}` });
  }

  files = {
    list: async (dir: string) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Map<string, "file" | "dir">();
      for (const file of this.fileStore.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "dir");
      }
      const entries = [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}`, size: 0, modifiedAt: "2026-11-20T09:00:00.000Z" }));
      return { entries, truncated: false };
    },
    stat: async (file: string) => ({ path: file, kind: "file" as const, size: this.fileStore.get(file)?.bytes.length ?? 0, modifiedAt: "2026-11-20T09:00:00.000Z" }),
    read: async (file: string) => {
      const stored = this.fileStore.get(file);
      if (stored === undefined) throw bridgeError("not_found");
      return { path: file, bytes: new Uint8Array(stored.bytes), size: stored.bytes.length, version: stored.version, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    },
    write: async (file: string, bytes: Uint8Array, options: { ifVersion: string | null }) => {
      this.writes.push({ path: file, ifVersion: options.ifVersion });
      const existing = this.fileStore.get(file);
      if (options.ifVersion === null ? existing !== undefined : existing?.version !== options.ifVersion) throw bridgeError("version_conflict");
      this.put(file, new Uint8Array(bytes));
      return { path: file, size: bytes.length, version: this.fileStore.get(file)!.version };
    },
    mkdir: async () => undefined,
    openRequest: async () => {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      return request;
    },
    onOpenRequest: () => () => undefined,
  };

  db = {
    find: async (table: string, query?: { where?: Record<string, unknown> }) =>
      table !== "recent_files" ? [] : this.rows.filter((row) => Object.entries(query?.where ?? {}).every(([key, value]) => row[key] === value)),
    insert: async (table: string, row: Record<string, unknown>) => {
      if (table !== "recent_files") throw new Error("unknown table");
      const id = `r${this.rows.length + 1}`;
      this.rows.push({ id, ...row });
      return { id };
    },
    update: async (table: string, id: string, patch: Record<string, unknown>) => {
      const row = this.rows.find((candidate) => candidate.id === id);
      if (table !== "recent_files" || row === undefined) return { ok: false };
      Object.assign(row, patch);
      return { ok: true };
    },
    delete: async (table: string, id: string) => {
      const at = this.rows.findIndex((row) => row.id === id);
      if (table === "recent_files" && at >= 0) this.rows.splice(at, 1);
      return { ok: at >= 0 };
    },
  };

  readData = async (key: string) => this.kv.get(key) ?? null;
  writeData = async (key: string, value: unknown) => {
    this.kv.set(key, JSON.parse(JSON.stringify(value)));
  };

  ai = {
    routes: async () => ({ routes: [], defaultRoute: null }),
    generate: async ({ prompt }: { prompt: string }) => {
      this.prompts.push(prompt);
      const reply = this.replies.shift();
      if (reply === undefined) throw new Error("no reply queued");
      return { text: reply };
    },
  };

  /** Sheets never calls integrations; any call is recorded and fails the journey. */
  service = async (service: string, action: string) => {
    this.serviceCalls.push(`${service}.${action}`);
    return { ok: false, error: "not used by Sheets" };
  };
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountApp(bridge: FakeMatrixOS | null) {
  if (bridge !== null) (window as Win).MatrixOS = bridge;
  const { default: App } = await import("../../../home/apps/sheets/src/App");
  const view = render(<App />);
  await settle();
  return view;
}

function grid(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[role='grid']")!;
}

function cellText(container: HTMLElement, row: number, col: number): string {
  return container.querySelector(`[role='gridcell'][data-row='${row}'][data-col='${col}']`)?.textContent ?? "";
}

function goTo(address: string): void {
  const box = screen.getByRole("textbox", { name: /^Name box/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: address } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  delete (window as Win).MatrixOS;
});

describe("Sheets app journey", () => {
  it("opens an .xlsx from Files, recalculates an edit, reviews assistant changes cell by cell and saves", async () => {
    const os = new FakeMatrixOS();
    os.put(MODEL_PATH, fixture("model.xlsx"));
    os.pendingRequest = { path: MODEL_PATH, requestedAt: "2026-11-20T09:59:00.000Z", nonce: "n-1" };
    const { container } = await mountApp(os);

    // Opened from the Files request: title, tabs, recent file.
    const tabs = within(await screen.findByRole("tablist", { name: "Sheets" }, { timeout: 5000 }));
    expect(screen.getByText("model.xlsx")).toBeTruthy();
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Assumptions", "Projection", "Summary"]);
    expect(os.rows.map((row) => row.path)).toEqual([MODEL_PATH]);

    // The owner raises monthly growth (Assumptions!B3) from 3% to 5%.
    goTo("B3");
    fireEvent.keyDown(grid(container), { key: "0" });
    const editor = container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")!;
    fireEvent.change(editor, { target: { value: "0.05" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await settle();

    fireEvent.click(tabs.getByRole("tab", { name: /Projection/ }));
    await settle();
    // Projection!N4 = SUM(B4:M4), was 709,601.48 at 3% growth.
    const projected = 50000 * ((1.05 ** 12 - 1) / 0.05);
    expect(Number(cellText(container, 3, 13).replace(/[^\d.]/g, ""))).toBeCloseTo(projected, 0);
    expect(screen.getByText("Edited")).toBeTruthy();

    // The assistant proposes two changes; nothing is final until reviewed.
    os.replies.push(
      JSON.stringify({
        kind: "sheet",
        edits: [
          { op: "setCell", sheet: "Summary", cell: "B2", value: "=Projection!N4", expect: "725,000" },
          { op: "setCell", sheet: "Assumptions", cell: "B5", value: 20000 },
        ],
        summary: "Links the total revenue to the projection and raises costs.",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await settle();
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "Make the total revenue a formula" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await settle();
    expect(os.prompts).toHaveLength(1);
    expect(os.prompts[0]).toContain(OPEN_MARKER);
    expect(screen.getByText("Links the total revenue to the projection and raises costs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review, 2 proposed changes/ })).toBeTruthy();

    // Review shows each cell's old and new value.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await settle();
    const review = screen.getByRole("complementary", { name: "Review changes" });
    const summaryRow = within(review).getByRole("button", { name: "Go to Summary!B2" }).closest("li")!;
    expect(summaryRow.querySelector("del")!.textContent).toContain("725,000");
    expect(summaryRow.querySelector("ins")!.textContent).toContain("=Projection!N4");
    const costRow = within(review).getByRole("button", { name: "Go to Assumptions!B5" }).closest("li")!;
    expect(costRow.querySelector("del")!.textContent).toMatch(/18,?000/);
    expect(costRow.querySelector("ins")!.textContent).toMatch(/20,?000/);

    fireEvent.click(within(review).getByRole("button", { name: "Accept change at Summary!B2" }));
    await settle();
    fireEvent.click(within(review).getByRole("button", { name: "Reject change at Assumptions!B5" }));
    await settle();
    expect(within(review).getByText("No changes to review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();

    // Summary!B2 now follows the recalculated projection.
    fireEvent.click(tabs.getByRole("tab", { name: /Summary/ }));
    await settle();
    expect(Number(cellText(container, 1, 1).replace(/[^\d.]/g, ""))).toBeCloseTo(projected, 0);

    // Save writes with the version that was read, then the file reads back as edited.
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await settle();
    expect(os.writes).toEqual([{ path: MODEL_PATH, ifVersion: "v1" }]);
    expect(screen.getByText("Saved")).toBeTruthy();

    const saved = await openXlsx(os.fileStore.get(MODEL_PATH)!.bytes);
    const id = (name: string) => saved.getSheetByName(name)!.id;
    expect(saved.getCell(id("Assumptions"), { row: 2, col: 1 }).value).toBe(0.05);
    expect(saved.getCell(id("Assumptions"), { row: 4, col: 1 }).value).toBe(18000);
    expect(saved.getCell(id("Summary"), { row: 1, col: 1 }).formula).toBe("Projection!N4");
    expect(saved.listChanges()).toEqual([]);
    expect(os.serviceCalls).toEqual([]);
  });

  it("refuses to overwrite a corrupt file and explains it", async () => {
    const os = new FakeMatrixOS();
    os.put("Documents/broken.xlsx", fixture("data.csv"));
    os.pendingRequest = { path: "Documents/broken.xlsx", requestedAt: "2026-11-20T09:59:00.000Z", nonce: "n-2" };
    await mountApp(os);
    expect(await screen.findByText("Sheets cannot open this kind of file", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/The file was not changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    await settle();
    expect(screen.getByRole("button", { name: /^New blank workbook/ })).toBeTruthy();
    expect(os.writes).toEqual([]);
  });

  it("starts on the start screen and opens a .csv through the file picker", async () => {
    const os = new FakeMatrixOS();
    os.put("Documents/data.csv", fixture("data.csv"));
    const { container } = await mountApp(os);
    expect(screen.getByText("No recent workbooks")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Open from Matrix/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
    fireEvent.click(await screen.findByRole("button", { name: "data.csv" }));
    await screen.findByRole("tablist", { name: "Sheets" }, { timeout: 5000 });
    expect(screen.getByText("data.csv")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cellText(container, 0, 1)).toBe("name");
    expect(cellText(container, 5, 1)).toBe("李华");
    expect(os.rows.map((row) => row.path)).toEqual(["Documents/data.csv"]);
  });

  it("explains that files are unavailable when the window has no bridge", async () => {
    await mountApp(null);
    expect(screen.getByText("Files are not available in this window")).toBeTruthy();
  });
});
