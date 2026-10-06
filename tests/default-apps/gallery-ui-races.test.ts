// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import Gallery from "../../home/apps/app-gallery/src/App";
import Starter from "../../home/app-templates/connected-starter/src/App";
import { Editor } from "../../home/app-templates/connected-starter/src/Dialogs";
import Focus from "../../home/app-templates/connected-starter/src/views/Focus";
import catalog from "../../home/system/app-gallery.json";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";

const folio = catalog.apps.find(app => app.id === "folio") as Definition;
const focus = catalog.apps.find(app => app.id === "focus") as Definition;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function bridge(value: Record<string, unknown>) {
  (window as unknown as { MatrixOS?: Record<string, unknown> }).MatrixOS = value;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.MatrixOS;
});

describe("gallery discovery and install races", () => {
  it("keeps a confirmed install when an older refresh settles afterwards", async () => {
    const inventory = deferred<unknown[]>();
    bridge({
      gatewayFetch: vi.fn(async (url: string) => url.endsWith("/install")
        ? { status: "installed", slug: "folio", name: "Folio", path: "apps/folio" }
        : { version: 1, apps: [{ ...folio, installed: false }] }),
      integrations: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => inventory.promise),
    });
    render(createElement(Gallery));
    await screen.findByRole("button", { name: "Install" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh gallery and connections" }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await screen.findByRole("button", { name: "Open" });
    await act(async () => { inventory.resolve([]); });
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh gallery and connections" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("editor submission snapshots", () => {
  it("locks every draft field until a successful save settles", async () => {
    const pending = deferred<void>();
    const save = vi.fn((_record: OwnerRecord) => pending.promise), close = vi.fn();
    render(createElement(Editor, { app: folio, onSave: save, onArchive: async () => {}, onClose: close }));
    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "Receipt" } });
    fireEvent.change(screen.getByLabelText("Currency *"), { target: { value: "SEK" } });
    fireEvent.click(screen.getByRole("button", { name: "Save record" }));
    expect(save).toHaveBeenCalledTimes(1);
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".editor input,.editor textarea,.editor select")) {
      expect(field.disabled).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].fields.title).toBe("Receipt");
  });
});

async function completeFocus() {
  fireEvent.change(screen.getByLabelText("Focus task"), { target: { value: "Review records" } });
  fireEvent.change(screen.getByLabelText("Session"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Begin focus" }));
  await act(async () => { vi.advanceTimersByTime(300000); });
}

describe("Focus session lifecycle", () => {
  it("locks the task while the completed session is saving", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>(), save = vi.fn((_record: OwnerRecord) => pending.promise);
    render(createElement(Focus, { app: focus, records: [], onEdit: () => {}, onEvidence: () => {}, onAdd: () => {}, onSave: save }));
    await completeFocus();
    fireEvent.click(screen.getByRole("button", { name: "Log completed session" }));
    expect((screen.getByLabelText("Focus task") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { pending.resolve(); });
    expect(save.mock.calls[0][0].fields.title).toBe("Review records");
    expect((screen.getByLabelText("Focus task") as HTMLInputElement).disabled).toBe(false);
  });

  it.each([false, true])("keeps an empty workspace session through reload (completed=%s)", async completed => {
    const pending = deferred<Record<string, unknown>[]>();
    bridge({ db: { find: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => pending.promise) } });
    render(createElement(Starter, { app: focus }));
    await waitFor(() => expect(screen.queryByText("Loading your saved records…")).toBeNull());
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Focus task"), { target: { value: "Review records" } });
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Begin focus" }));
    await act(async () => { vi.advanceTimersByTime(completed ? 300000 : 60000); });
    fireEvent.click(screen.getByRole("button", { name: "Check records" }));
    expect((screen.getByLabelText("Focus task") as HTMLInputElement).value).toBe("Review records");
    await act(async () => { pending.resolve([]); });
    expect((screen.getByLabelText("Focus task") as HTMLInputElement).value).toBe("Review records");
    if (completed) {
      expect(screen.getByRole("button", { name: "Log completed session" })).toBeTruthy();
    } else {
      expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
      expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("4 minutes 0 seconds remaining");
      await act(async () => { vi.advanceTimersByTime(60000); });
      expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("3 minutes 0 seconds remaining");
    }
  });
});
