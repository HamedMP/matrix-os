// @vitest-environment jsdom
/**
 * Leaving a document for the start screen (the back button and File > Close)
 * with the Save, Discard, Cancel question, and documents opened from this
 * computer: the chooser and a drop open them as local documents, Save
 * downloads them, and Save a copy to Matrix turns them into home documents
 * that then appear in the recent list.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docxFromParagraphs, fileMenu, findSurface, installBridge, renderApp, titleText, typeInto } from "./harness";

const downloads: Array<{ name: string; blob: Blob }> = [];

beforeEach(() => {
  downloads.length = 0;
  let pendingBlob: Blob | null = null;
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      pendingBlob = blob;
      return "blob:docs-test";
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (pendingBlob !== null) downloads.push({ name: this.download, blob: pendingBlob });
    pendingBlob = null;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function backHome(): void {
  fireEvent.click(screen.getByRole("button", { name: "Back to Docs home" }));
}

async function recentNames(): Promise<string[]> {
  const heading = await screen.findByRole("heading", { name: "Recent documents" });
  return [...heading.closest("section")!.querySelectorAll(".oui-recent__name")].map((node) => node.textContent ?? "");
}

/** Makes the next hidden file input "choose" this file. */
function chooseOnNextPicker(file: File): void {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementationOnce(function (this: HTMLInputElement) {
    Object.defineProperty(this, "files", { configurable: true, value: [file] });
    this.dispatchEvent(new Event("change"));
  });
}

async function localFile(name: string, paragraphs: string[]): Promise<File> {
  return new File([await docxFromParagraphs(paragraphs)], name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

describe("Docs back to home", () => {
  it("returns to the start screen at once when nothing changed, with the document in the recent list", async () => {
    installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "Documents/plan.docx" });
    renderApp();
    await findSurface();
    backHome();
    await waitFor(async () => expect(await recentNames()).toEqual(["plan.docx"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks Save, Discard or Cancel for unsaved changes; Cancel keeps the document and Save writes it and goes home", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "Documents/plan.docx" });
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, "!"));
    backHome();
    let dialog = await screen.findByRole("alertdialog", { name: "Save changes to “plan.docx”?" });
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(expect.arrayContaining(["Save", "Discard", "Cancel"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((await findSurface()).textContent).toBe("Plan!");
    expect(bridge.files.writes).toEqual([]);

    fileMenu("Close");
    dialog = await screen.findByRole("alertdialog", { name: /Save changes/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await recentNames()).toEqual(["plan.docx"]));
    expect(bridge.files.writes.map((write) => write.path)).toEqual(["Documents/plan.docx"]);
  });

  it("keeps the document open and shows why when the save fails", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "Documents/plan.docx" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, "!"));
    bridge.files.failNext("write", "unavailable");
    backHome();
    const dialog = await screen.findByRole("alertdialog", { name: /Save changes/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Not saved\..*could not be reached/);
    expect(await findSurface()).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByRole("heading", { name: "Recent documents" });
    expect(bridge.files.bytes("Documents/plan.docx")).not.toBeNull();
    warn.mockRestore();
  });

  it("asks where to save a new document before going home, then lists it", async () => {
    const bridge = installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Blank document/ }));
    const surface = await findSurface();
    act(() => typeInto(surface, "Hello"));
    backHome();
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: /Save changes/ })).getByRole("button", { name: "Save" }));
    const save = await screen.findByRole("dialog", { name: "Save document" });
    fireEvent.change(within(save).getByLabelText("File name"), { target: { value: "hello" } });
    fireEvent.click(within(save).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await recentNames()).toEqual(["hello.docx"]));
    expect(bridge.files.has("Documents/hello.docx")).toBe(true);
  });
});

describe("Docs documents from this computer", () => {
  it("opens a chosen file as a local document, downloads it on Save and keeps it out of recents", async () => {
    const bridge = installBridge({});
    renderApp();
    chooseOnNextPicker(await localFile("Report.docx", ["From disk"]));
    fireEvent.click(await screen.findByRole("button", { name: "Choose a file…" }));
    const surface = await findSurface();
    expect(surface.textContent).toBe("From disk");
    expect(titleText()).toBe("Report.docx");
    expect(screen.getByText("From this computer")).toBeTruthy();

    act(() => typeInto(surface, "!"));
    fireEvent.keyDown(surface, { key: "s", ctrlKey: true });
    await screen.findByText("Downloaded Report.docx");
    expect(downloads.map((entry) => entry.name)).toEqual(["Report.docx"]);
    expect(downloads[0]!.blob.size).toBeGreaterThan(0);
    expect(screen.getByTestId("save-state").textContent).toBe("Downloaded");
    expect(bridge.files.writes).toEqual([]);

    backHome();
    expect(await recentNames()).toEqual([]);
  });

  it("opens a dropped file and becomes a Matrix document after Save a copy to Matrix", async () => {
    const bridge = installBridge({});
    renderApp();
    const target = await screen.findByRole("heading", { name: "Recent documents" });
    const file = await localFile("Budget notes.docx", ["Numbers"]);
    fireEvent.dragEnter(target, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.drop(target, { dataTransfer: { types: ["Files"], files: [file] } });
    const surface = await findSurface();
    expect(titleText()).toBe("Budget notes.docx");

    fileMenu("Save a copy to Matrix…");
    const dialog = await screen.findByRole("dialog", { name: "Save a copy to Matrix" });
    expect((within(dialog).getByLabelText("File name") as HTMLInputElement).value).toBe("Budget notes.docx");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved to Matrix");
    expect(bridge.files.has("Documents/Budget notes.docx")).toBe(true);
    expect(screen.queryByText("From this computer")).toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("Saved");

    act(() => typeInto(surface, "!"));
    fireEvent.keyDown(surface, { key: "s", ctrlKey: true });
    await waitFor(() => expect(bridge.files.writes.map((write) => write.path)).toEqual(["Documents/Budget notes.docx", "Documents/Budget notes.docx"]));
    expect(downloads).toEqual([]);
    backHome();
    await waitFor(async () => expect(await recentNames()).toEqual(["Budget notes.docx"]));
  });

  it("refuses a file that is not a Word document with a message", async () => {
    installBridge({});
    renderApp();
    chooseOnNextPicker(new File(["a,b"], "sales.csv", { type: "text/csv" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose a file…" }));
    expect(await screen.findByText("The file could not be opened")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Document" })).toBeNull();
  });

  it("downloads a copy of a Matrix document from the File menu without saving it", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "Documents/plan.docx" });
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, "!"));
    fileMenu("Download a copy");
    await waitFor(() => expect(downloads.map((entry) => entry.name)).toEqual(["plan.docx"]));
    expect(screen.getByTestId("save-state").textContent).toBe("Unsaved changes");
    expect(bridge.files.writes).toEqual([]);
  });
});
