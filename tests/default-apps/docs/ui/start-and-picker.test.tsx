// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDocxFromMarkdown, openDocx, toPlainText } from "../../../../home/apps/_shared/office-engine/index";
import { templateMarkdown } from "../../../../home/apps/docs/src/ui/templates";
import { docxFromParagraphs, fileMenu, findSurface, installBridge, renderApp, titleText } from "./harness";

afterEach(cleanup);

function matrixList(): Promise<HTMLElement> {
  return screen.findByRole("list", { name: "Folders and files" });
}

describe("Docs start screen", () => {
  it("lists recent documents with their folder and opens one", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) });
    await bridge.db.insert("recent_documents", { path: "Documents/plan.docx", name: "plan.docx", opened_at: "2026-11-22T10:00:00.000Z" });
    renderApp();
    const recent = await screen.findByRole("button", { name: /^plan\.docx, in Documents/ });
    expect(recent.textContent).toContain("Documents");
    fireEvent.click(recent);
    expect((await findSurface()).textContent).toBe("Plan");
  });

  it("removes a document from the recent list and the store", async () => {
    const bridge = installBridge({ "a.docx": await docxFromParagraphs(["A"]), "b.docx": await docxFromParagraphs(["B"]) });
    await bridge.db.insert("recent_documents", { path: "a.docx", name: "a.docx", opened_at: "2026-11-22T10:00:00.000Z" });
    await bridge.db.insert("recent_documents", { path: "b.docx", name: "b.docx", opened_at: "2026-11-23T10:00:00.000Z" });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Remove a.docx from recent" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^a\.docx, in/ })).toBeNull());
    const left = screen.getByRole("button", { name: /^b\.docx, in/ });
    left.focus();
    fireEvent.keyDown(left, { key: "Delete" });
    expect(await screen.findByRole("heading", { name: "No recent documents" })).toBeTruthy();
    expect(await bridge.db.find("recent_documents", {})).toEqual([]);
  });

  it("starts a blank document", async () => {
    installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Blank document/ }));
    const surface = await findSurface();
    expect(surface.textContent).toBe("");
    expect(titleText()).toContain("Untitled");
  });

  it("starts a memo and meeting notes from their templates", async () => {
    installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Memo/ }));
    expect((await findSurface()).textContent).toContain("MemoTo: RecipientsFrom: Rae Okafor");
    expect(titleText()).toContain("Memo");
    cleanup();
    installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Meeting notes/ }));
    const notes = await findSurface();
    expect(notes.textContent).toMatch(/^Meeting notesDate: .+Attendees: Rae OkaforAgenda/);
    expect(notes.querySelector("table")).not.toBeNull();
  });

  it("creates a document from pasted Markdown", async () => {
    installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /New from Markdown/ }));
    const dialog = await screen.findByRole("dialog", { name: /New from Markdown/ });
    fireEvent.change(within(dialog).getByLabelText("Markdown"), { target: { value: "# Launch plan\n\nShip it **soon**." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    const surface = await findSurface();
    expect(surface.textContent).toBe("Launch planShip it soon.");
    expect(titleText()).toContain("Launch plan");
  });

  it("browses the Matrix home on the start screen: folders and .docx only, and opens a document", async () => {
    const bridge = installBridge(
      { "Documents/Legal/msa.docx": await docxFromParagraphs(["Master agreement"]), "top.docx": await docxFromParagraphs(["Top"]) },
      { extraPaths: ["system/config.json", "notes.md", "Documents/budget.xlsx", ".hidden/x.docx"] },
    );
    renderApp();
    const list = await matrixList();
    await within(list).findByRole("button", { name: /^top\.docx/ });
    expect(within(list).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Folder Documents", expect.stringMatching(/^top\.docx/)]);
    fireEvent.click(within(list).getByRole("button", { name: "Folder Documents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Folder Legal" }));
    expect(screen.queryByText("budget.xlsx")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^msa\.docx/ }));
    expect((await findSurface()).textContent).toBe("Master agreement");
    expect(bridge.listCalls).toEqual(expect.arrayContaining(["", "Documents", "Documents/Legal"]));
  });
});

describe("Docs templates", () => {
  const context = { author: "Rae | Okafor", date: new Date("2026-11-25T12:00:00Z"), locale: "en-GB" };

  it("build real documents that the engine reopens with their structure", async () => {
    for (const id of ["memo", "meeting-notes"] as const) {
      const reopened = await openDocx(await createDocxFromMarkdown(templateMarkdown(id, context)!, { title: id, author: "Rae" }).save());
      const text = toPlainText(reopened);
      expect(text).toContain(id === "memo" ? "Subject:" : "Action items");
      expect(text).toContain("25 November 2026");
      // The owner's name cannot break the Markdown table.
      expect(text).toContain("Rae Okafor");
    }
    expect(templateMarkdown("blank", context)).toBeNull();
  });
});

describe("Docs remembers the folder the owner last used", () => {
  it("starts the browser there, on the start screen and in the Open dialog, and remembers the next folder", async () => {
    installBridge({ "Work/Q3/plan.docx": await docxFromParagraphs(["Plan"]), "Work/notes.docx": await docxFromParagraphs(["Notes"]) });
    const store = new Map<string, unknown>([["start_folder", { dir: "Work/Q3" }]]);
    Object.assign((window as unknown as { MatrixOS: object }).MatrixOS, {
      readData: async (key: string) => store.get(key) ?? null,
      writeData: async (key: string, value: unknown) => void store.set(key, value),
    });
    renderApp();
    const list = await matrixList();
    await within(list).findByRole("button", { name: /^plan\.docx/ });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", { name: "Work" }));
    await screen.findByRole("button", { name: /^notes\.docx/ });
    await waitFor(() => expect(store.get("start_folder")).toEqual({ dir: "Work" }));

    fireEvent.click(screen.getByRole("button", { name: /^Blank document/ }));
    await findSurface();
    fileMenu(/^Open from Matrix/);
    const dialog = await screen.findByRole("dialog", { name: "Open a document" });
    expect(await within(dialog).findByRole("button", { name: /^notes\.docx/ })).toBeTruthy();
  });
});

describe("Docs open dialog", () => {
  async function openDialog() {
    fireEvent.click(await screen.findByRole("button", { name: /^Blank document/ }));
    await findSurface();
    fileMenu(/^Open from Matrix/);
    return screen.findByRole("dialog", { name: "Open a document" });
  }

  it("uses the same Matrix browser and opens the chosen file", async () => {
    installBridge({ "Documents/a.docx": await docxFromParagraphs(["A"]) }, { extraPaths: ["Documents/notes.md"] });
    renderApp();
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Folder Documents" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /^a\.docx/ }));
    expect(within(dialog).queryByText("notes.md")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open a document" })).toBeNull());
    await waitFor(async () => expect((await findSurface()).textContent).toBe("A"));
  });

  it("returns home through the breadcrumb and shows listing failures", async () => {
    const bridge = installBridge({ "Documents/a.docx": await docxFromParagraphs(["A"]) });
    renderApp();
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Folder Documents" }));
    await within(dialog).findByRole("button", { name: /^a\.docx/ });
    bridge.failListOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Home" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/could not be listed/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("button", { name: "Folder Documents" });
  });
});
