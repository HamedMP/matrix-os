// @vitest-environment jsdom
/**
 * Dialogs and panel drafts made for one document never act on another: when
 * a different document becomes the active one (here an "Open with" request
 * from Files), the Save as dialog, the unsaved-changes question, the Compare
 * file picker and the comment drafts made for the first document go away.
 */

import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { useDocumentBound } from "../../../../home/apps/docs/src/ui/document-bound";
import { createFakeFiles } from "../session/fakes";
import { docxFromParagraphs, fileMenu, findSurface, installBridge, renderApp, titleText, typeInto } from "./harness";

afterEach(() => {
  cleanup();
  delete (window as { MatrixOS?: unknown }).MatrixOS;
});

function ribbonTab(name: string): void {
  fireEvent.click(within(screen.getByRole("tablist", { name: "Document ribbon" })).getByRole("tab", { name }));
}

function openSidePanel(): HTMLElement {
  ribbonTab("View");
  fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
  return screen.getByRole("complementary", { name: "Review, assistant and compare" });
}

async function localFile(name: string, paragraphs: string[]): Promise<File> {
  return new File([await docxFromParagraphs(paragraphs)], name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

describe("useDocumentBound", () => {
  it("hides a value once another document is active, reports it dropped once, and binds a new value to the new document", async () => {
    const session = new DocumentSession({ files: createFakeFiles(), author: "Rae Okafor", autosave: false });
    await session.adopt(createDocx({ paragraphs: ["One"] }), { name: "One", dirty: false });
    const dropped: string[] = [];
    const { result } = renderHook(() => useDocumentBound<string>(session, (value) => dropped.push(value)));
    act(() => result.current[1]("for one"));
    expect(result.current[0]).toBe("for one");

    await act(async () => {
      await session.adopt(createDocx({ paragraphs: ["Two"] }), { name: "Two", dirty: false, discardChanges: true });
    });
    expect(result.current[0]).toBeNull();
    expect(dropped).toEqual(["for one"]);

    act(() => result.current[1]("for two"));
    expect(result.current[0]).toBe("for two");
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    await act(async () => {
      await session.close({ discardChanges: true });
    });
    expect(dropped).toEqual(["for one"]);
    session.dispose();
  });
});

describe("Docs dialogs bound to their document", () => {
  it("closes Save a copy to Matrix when another document opens, so it never writes that one under the first name", async () => {
    const bridge = installBridge({ "Documents/other.docx": await docxFromParagraphs(["Other"]) });
    renderApp();
    const target = await screen.findByRole("heading", { name: "Recent documents" });
    fireEvent.drop(target, { dataTransfer: { types: ["Files"], files: [await localFile("Budget notes.docx", ["Numbers"])] } });
    await findSurface();
    fileMenu("Save a copy to Matrix…");
    await screen.findByRole("dialog", { name: "Save a copy to Matrix" });

    act(() => bridge.sendOpenRequest("Documents/other.docx"));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Other"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save a copy to Matrix" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Save document" })).toBeNull();
    expect(bridge.files.has("Documents/Budget notes.docx")).toBe(false);
    expect(bridge.files.writes).toEqual([]);
  });

  it("drops the unsaved-changes question when another document opens, so Discard never closes that one", async () => {
    const bridge = installBridge(
      {
        "Documents/a.docx": await docxFromParagraphs(["First"]),
        "Documents/b.docx": await docxFromParagraphs(["Second"]),
      },
      { pending: "Documents/a.docx" },
    );
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, "!"));
    fireEvent.click(screen.getByRole("button", { name: "Back to Docs home" }));
    await screen.findByRole("alertdialog", { name: "Save changes to “a.docx”?" });

    // Files asks for b.docx: the session saves a.docx first and opens b.docx.
    act(() => bridge.sendOpenRequest("Documents/b.docx"));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Second"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(titleText()).toContain("b.docx");
  });

  it("closes the Compare file picker when another document opens", async () => {
    const bridge = installBridge(
      {
        "Documents/a.docx": await docxFromParagraphs(["First"]),
        "Documents/b.docx": await docxFromParagraphs(["Second"]),
      },
      { pending: "Documents/a.docx" },
    );
    renderApp();
    await findSurface();
    const side = openSidePanel();
    fireEvent.click(within(side).getByRole("tab", { name: /Compare/ }));
    fireEvent.click(await within(side).findByRole("button", { name: "Choose from Files…" }, { timeout: 5000 }));
    await screen.findByRole("dialog", { name: "Compare with another version" });

    act(() => bridge.sendOpenRequest("Documents/b.docx"));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Second"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Compare with another version" })).toBeNull());
  });

  it("starts the comment box empty for another document instead of carrying the first one's draft", async () => {
    const bridge = installBridge(
      {
        "Documents/a.docx": await docxFromParagraphs(["First"]),
        "Documents/b.docx": await docxFromParagraphs(["Second"]),
      },
      { pending: "Documents/a.docx" },
    );
    renderApp();
    await findSurface();
    const side = openSidePanel();
    const box = (await within(side).findByLabelText("New comment", {}, { timeout: 5000 })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "About the first document" } });
    expect(box.value).toBe("About the first document");

    act(() => bridge.sendOpenRequest("Documents/b.docx"));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Second"));
    const after = screen.getByRole("complementary", { name: "Review, assistant and compare" });
    await waitFor(() => expect((within(after).getByLabelText("New comment") as HTMLTextAreaElement).value).toBe(""));
  });
});
