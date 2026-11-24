import { act, render, screen } from "@testing-library/react";
import React from "react";
import { createXlsx, type Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { ToastProvider } from "../../../../home/apps/_shared/office-ui";
import type { SheetGridController } from "../../../../home/apps/sheets/src/grid";
import { SessionHost } from "../../../../home/apps/sheets/src/session";
import type { SheetSession } from "../../../../home/apps/sheets/src/session/session";
import type { SheetsBridge } from "../../../../home/apps/sheets/src/ui/bridge";
import { SheetsApp } from "../../../../home/apps/sheets/src/ui/SheetsApp";
import { FakeDb, FakeFiles, FakeTimers, settle } from "../session/fakes";

type OpenRequest = { path: string; requestedAt: string; nonce: string };

/** A fake `window.MatrixOS` over in-memory files, a recent-files table and a key-value store. */
export class FakeBridge implements SheetsBridge {
  readonly fileStore = new FakeFiles();
  readonly db = new FakeDb();
  readonly kv: Record<string, unknown> = {};
  readonly kvWrites: string[] = [];
  pendingRequest: OpenRequest | null = null;
  openRequestCalls = 0;
  private openListeners = new Set<(request: OpenRequest) => void>();
  readonly files: SheetsBridge["files"];

  constructor() {
    const store = this.fileStore;
    this.files = {
      read: (path) => store.read(path),
      write: (path, bytes, options) => store.write(path, bytes, options),
      list: async (dir) => {
        const prefix = dir === "" ? "" : `${dir}/`;
        const names = new Map<string, "file" | "dir">();
        for (const path of store.store.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "dir");
        }
        const entries = [...names.entries()]
          .map(([name, kind]) => ({ name, kind, path: `${prefix}${name}`, size: 0, modifiedAt: new Date(0).toISOString() }))
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
        return { entries, truncated: false };
      },
      openRequest: async () => {
        this.openRequestCalls++;
        const request = this.pendingRequest;
        this.pendingRequest = null;
        return request;
      },
      onOpenRequest: (callback) => {
        this.openListeners.add(callback);
        return () => this.openListeners.delete(callback);
      },
    };
  }

  readData = async (key: string): Promise<unknown> => this.kv[key] ?? null;
  writeData = async (key: string, value: unknown): Promise<void> => {
    this.kvWrites.push(key);
    this.kv[key] = JSON.parse(JSON.stringify(value));
  };

  requestOpen(path: string): void {
    for (const listener of [...this.openListeners]) listener({ path, requestedAt: new Date(0).toISOString(), nonce: path });
  }
}

/** Bytes of a workbook built by `build` (default: A1..A3 = 1, 2, 3; B1 = SUM(A1:A3); C1 = "apple"). */
export async function workbookBytes(build?: (workbook: Workbook, sheet: string) => void): Promise<Uint8Array> {
  const workbook = createXlsx();
  const sheet = workbook.listSheets()[0]!.id;
  if (build === undefined) {
    workbook.setRange(sheet, { row: 0, col: 0 }, [[1], [2], [3]]);
    workbook.setFormula(sheet, { row: 0, col: 1 }, "SUM(A1:A3)");
    workbook.setCell(sheet, { row: 0, col: 2 }, "apple");
  } else {
    build(workbook, sheet);
  }
  workbook.recalc();
  return workbook.save();
}

export interface Downloaded {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface AppHarness {
  bridge: FakeBridge;
  /** Files the app handed to the computer, in order. */
  downloads: Downloaded[];
  timers: FakeTimers;
  host: SessionHost;
  container: HTMLElement;
  /** The open session; throws when none is open. */
  session(): SheetSession;
  unmount(): void;
}

export async function renderApp(setup?: (bridge: FakeBridge) => void | Promise<void>): Promise<AppHarness> {
  const bridge = new FakeBridge();
  await setup?.(bridge);
  const timers = new FakeTimers();
  const host = new SessionHost({ files: bridge.files, db: bridge.db, timers, autosaveDelayMs: 60_000 });
  const downloads: Downloaded[] = [];
  const download = (name: string, bytes: Uint8Array, mimeType: string): void => void downloads.push({ name, bytes, mimeType });
  const view = render(
    <ToastProvider>
      <SheetsApp bridge={bridge} host={host} download={download} />
    </ToastProvider>,
  );
  await act(async () => {
    await settle();
  });
  const session = (): SheetSession => {
    const open = host.session;
    if (open === null) throw new Error("no workbook is open");
    return open;
  };
  return { bridge, downloads, timers, host, container: view.container, session, unmount: view.unmount };
}

/** Opens `path` (put into the fake files first) through an open request and waits for the workbook. */
export async function renderWithWorkbook(path = "Budget.xlsx", build?: (workbook: Workbook, sheet: string) => void): Promise<AppHarness> {
  const bytes = await workbookBytes(build);
  return renderApp((bridge) => {
    bridge.fileStore.put(path, bytes);
    bridge.pendingRequest = { path, requestedAt: new Date(0).toISOString(), nonce: "n1" };
  });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await settle();
  });
}

/** Opens a toolbar dropdown by its accessible name and picks an item. */
export async function pick(menu: string | RegExp, item: string | RegExp): Promise<void> {
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.click(screen.getByRole("button", { name: menu }));
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role^='menuitem']")).find((element) => (typeof item === "string" ? element.textContent?.includes(item) : item.test(element.textContent ?? "")));
  if (option === undefined) throw new Error(`no menu item ${String(item)}`);
  fireEvent.click(option);
}

/** The grid controller, read through the active cell's grid element. */
export function gridOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[role='grid']")!;
}

export type { SheetGridController };
