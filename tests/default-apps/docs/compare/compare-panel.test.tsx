// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "../../../../home/apps/docs/src/ui/compare/ComparePanel";
import type { DocumentEditorController } from "../../../../home/apps/docs/src/editor/index";
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

  it("explains a file that cannot be compared", async () => {
    const { session } = await contractSession();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<ComparePanel session={session} editor={null} />);
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [new File(["hello"], "notes.docx")] } });
    await until(() => screen.queryByRole("alert") !== null);
    expect(screen.getByRole("alert").textContent).toContain("That file is not a Word document this app can read.");
    fireEvent.change(screen.getByLabelText("Word document to compare with"), { target: { files: [new File(["hello"], "notes.txt")] } });
    await until(() => (screen.getByRole("alert").textContent ?? "").includes("Choose a Word document"));
    warn.mockRestore();
  });
});
