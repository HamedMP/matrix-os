// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { docxFromParagraphs, findSurface, installBridge, renderApp, titleText, typeInto } from "./harness";

afterEach(cleanup);

describe("Docs open requests", () => {
  it("opens the file Files asked for on load, reading the request once", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan text"]) }, { pending: "Documents/plan.docx" });
    renderApp();
    const surface = await findSurface();
    expect(surface.textContent).toBe("Plan text");
    expect(titleText()).toContain("plan.docx");
    expect(bridge.openRequestCalls).toBe(1);
  });

  it("opens requests that arrive while running and saves the current document first", async () => {
    const bridge = installBridge(
      {
        "a.docx": await docxFromParagraphs(["First"]),
        "b.docx": await docxFromParagraphs(["Second"]),
      },
      { pending: "a.docx" },
    );
    renderApp();
    expect((await findSurface()).textContent).toBe("First");
    act(() => bridge.sendOpenRequest("b.docx"));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Second"));
    expect(titleText()).toContain("b.docx");
  });

  it("refuses a request for a file that is not a Word document without reading it", async () => {
    const bridge = installBridge({ "data.xlsx": new Uint8Array([1, 2, 3]) });
    renderApp();
    await screen.findByRole("button", { name: /^Blank document/ });
    act(() => bridge.sendOpenRequest("data.xlsx"));
    expect(await screen.findByText(/Docs opens \.docx documents/)).toBeTruthy();
    expect(bridge.files.reads).toEqual([]);
  });

  it("explains a damaged file and never writes to it", async () => {
    const damaged = new Uint8Array([80, 75, 3, 4, 0, 0, 1, 2, 3]);
    const bridge = installBridge({ "broken.docx": damaged }, { pending: "broken.docx" });
    renderApp();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/damaged|not a Word document/);
    expect(alert.textContent).toMatch(/file was not changed/);
    expect(screen.queryByRole("textbox", { name: "Document" })).toBeNull();
    expect(bridge.files.writes).toEqual([]);
    expect(bridge.files.bytes("broken.docx")).toEqual(damaged);
  });

  it("asks before discarding an unsaved new document for an incoming request", async () => {
    const bridge = installBridge({ "b.docx": await docxFromParagraphs(["Second"]) });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Blank document/ }));
    const surface = await findSurface();
    act(() => typeInto(surface, "x"));
    act(() => bridge.sendOpenRequest("b.docx"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/unsaved/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /Discard/ }));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Second"));
  });
});
