// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "../../../../home/apps/docs/src/ui/compare/ComparePanel";
import type { DocumentEditorController } from "../../../../home/apps/docs/src/editor/index";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { contractSession, fixture } from "../agent/helpers";

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await settle();
  expect(check()).toBe(true);
}

function fakeEditor() {
  const editor = { setViewMode: vi.fn(), scrollTo: vi.fn() };
  return editor;
}

describe("<ComparePanel>", () => {
  it("compares with a document picked from Files, switches to markup and answers the substantive question", async () => {
    const { session, files } = await contractSession({ "Documents/contract-v2.docx": fixture("contract-v2.docx") });
    const editor = fakeEditor();
    const pickDocument = vi.fn(async () => "Documents/contract-v2.docx");
    render(<ComparePanel session={session} editor={editor as unknown as DocumentEditorController} pickDocument={pickDocument} files={files} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose from Files…" }));
    await until(() => screen.queryByRole("article") !== null);

    expect(pickDocument).toHaveBeenCalledWith({ title: "Compare with another version" });
    expect(editor.setViewMode).toHaveBeenCalledWith("markup");
    const card = screen.getByRole("article", { name: "Did anything substantive change?" });
    expect(within(card).getByText("Yes")).toBeTruthy();
    expect(within(card).getByText("Insertions")).toBeTruthy();
    expect(within(card).getByText("Substantive")).toBeTruthy();
    expect(session.getState()).toMatchObject({ path: null, dirty: true, name: "contract compared with contract-v2.docx" });

    const changes = within(card).getByRole("list", { name: "Changes" });
    fireEvent.click(within(changes).getAllByRole("button")[0]!);
    expect(editor.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("hides a finished comparison once its document is no longer the one open", async () => {
    const { session } = await contractSession();
    const editor = fakeEditor();
    render(<ComparePanel session={session} editor={editor as unknown as DocumentEditorController} />);
    const file = new File([fixture("contract-v2.docx")], "contract-v2.docx");
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [file] } });
    await until(() => screen.queryByRole("article") !== null);

    // Another document opens in the same workspace: the answer and its jump links belong to the comparison.
    await act(async () => {
      // The comparison is unsaved, so the owner leaves it without saving.
      expect(await session.adopt(createDocx({ paragraphs: ["Unrelated"] }), { name: "Other", dirty: false, discardChanges: true })).toMatchObject({ status: "opened" });
    });
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByRole("button", { name: "From this device…" })).toBeTruthy();

    // With no document open, the empty state shows instead of the old answer.
    await act(async () => {
      await session.close({ discardChanges: true });
    });
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("Nothing to compare yet")).toBeTruthy();
  });

  it("does nothing when the picker is cancelled", async () => {
    const { session, files } = await contractSession();
    const doc = session.requireDocument();
    render(<ComparePanel session={session} editor={null} pickDocument={async () => null} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose from Files…" }));
    await settle();
    expect(screen.queryByRole("article")).toBeNull();
    expect(session.requireDocument()).toBe(doc);
  });

  it("compares with a file from this device", async () => {
    const { session } = await contractSession();
    render(<ComparePanel session={session} editor={null} />);
    const file = new File([fixture("contract-v2.docx")], "contract-v2.docx");
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [file] } });
    await until(() => screen.queryByRole("article") !== null);
    expect(session.getState().revisionCount).toBeGreaterThan(0);
  });

  it("refuses a device file over the size limit, chosen or dropped, without reading it", async () => {
    const { session } = await contractSession();
    render(<ComparePanel session={session} editor={null} />);
    const huge = (): File => {
      const file = new File(["small"], "huge.docx");
      Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });
      Object.defineProperty(file, "arrayBuffer", { value: vi.fn(() => Promise.reject(new Error("read"))) });
      return file;
    };
    const chosen = huge();
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [chosen] } });
    await until(() => (screen.queryByRole("alert")?.textContent ?? "").includes("That file is too large to compare."));
    expect(chosen.arrayBuffer).not.toHaveBeenCalled();
    const dropped = huge();
    const panel = screen.getByRole("region", { name: "Choose the other version" }).parentElement!;
    fireEvent.drop(panel, { dataTransfer: { types: ["Files"], files: [dropped] } });
    await settle();
    expect(dropped.arrayBuffer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("That file is too large to compare.");
    expect(session.getState().revisionCount).toBe(0);
  });

  it("drops a comparison when the document is edited while the device file is read", async () => {
    const { session } = await contractSession();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<ComparePanel session={session} editor={null} />);
    const original = session.requireDocument();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const file = new File([fixture("contract-v2.docx")], "contract-v2.docx");
    const bytes = await file.arrayBuffer();
    Object.defineProperty(file, "arrayBuffer", { value: async () => (await gate, bytes) });
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [file] } });
    act(() => {
      session.apply([{ type: "insertText", at: { blockId: original.getView().body.blocks[0]!.id, offset: 0 }, text: "Late " }]);
    });
    release();
    await until(() => screen.queryByRole("alert") !== null);
    expect(screen.getByRole("alert").textContent).toContain("The document changed while comparing. Compare again.");
    expect(session.requireDocument()).toBe(original);
    warn.mockRestore();
  });

  it("explains a file that cannot be compared", async () => {
    const { session } = await contractSession();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<ComparePanel session={session} editor={null} />);
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [new File(["hello"], "notes.docx")] } });
    await until(() => screen.queryByRole("alert") !== null);
    expect(screen.getByRole("alert").textContent).toContain("That file is not a Word document this app can read.");
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [new File(["hello"], "notes.txt")] } });
    await until(() => (screen.getByRole("alert").textContent ?? "").includes("Choose a Word document"));
    // The note was about the document open then; another one opening clears it.
    await act(async () => {
      await session.adopt(createDocx({ paragraphs: ["Unrelated"] }), { name: "Other", dirty: false, discardChanges: true });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    warn.mockRestore();
  });
});
