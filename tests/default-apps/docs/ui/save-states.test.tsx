// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { docxFromParagraphs, findSurface, installBridge, renderApp, titleText, typeInto } from "./harness";

afterEach(cleanup);

function saveState(): string {
  return screen.getByTestId("save-state").textContent ?? "";
}

describe("Docs save states", () => {
  it("shows saved, unsaved and saved again after Save", async () => {
    const bridge = installBridge({ "plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    expect(saveState()).toBe("Saved");
    act(() => typeInto(surface, "!"));
    expect(saveState()).toBe("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveState()).toBe("Saved"));
    expect(bridge.files.writes.map((write) => write.path)).toEqual(["plan.docx"]);
  });

  it("saves with Ctrl+S", async () => {
    const bridge = installBridge({ "plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, "!"));
    fireEvent.keyDown(surface, { key: "s", ctrlKey: true });
    await waitFor(() => expect(bridge.files.writes).toHaveLength(1));
  });

  it("keeps the local document on a conflict and offers a copy", async () => {
    const original = await docxFromParagraphs(["Plan"]);
    const bridge = installBridge({ "plan.docx": original }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, " mine"));
    const theirs = await docxFromParagraphs(["Theirs"]);
    bridge.files.put("plan.docx", theirs);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveState()).toBe("Changed elsewhere"));
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/changed elsewhere/i);
    expect(surface.textContent).toBe("Plan mine");
    expect(bridge.files.bytes("plan.docx")).toEqual(theirs);

    fireEvent.click(within(banner).getByRole("button", { name: "Save a copy" }));
    await waitFor(() => expect(titleText()).toContain("plan (copy).docx"));
    expect(saveState()).toBe("Saved");
    expect(bridge.files.has("plan (copy).docx")).toBe(true);
    expect(bridge.files.bytes("plan.docx")).toEqual(theirs);
  });

  it("reloads the file on request after a conflict", async () => {
    const bridge = installBridge({ "plan.docx": await docxFromParagraphs(["Plan"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    act(() => typeInto(surface, " mine"));
    bridge.files.put("plan.docx", await docxFromParagraphs(["Theirs"]));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const banner = await screen.findByRole("alert");
    fireEvent.click(within(banner).getByRole("button", { name: /Reload/ }));
    await waitFor(async () => expect((await findSurface()).textContent).toBe("Theirs"));
    expect(saveState()).toBe("Saved");
  });

  it("asks for a name when saving a new document", async () => {
    const bridge = installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Blank document/ }));
    const surface = await findSurface();
    expect(saveState()).toBe("Not saved yet");
    act(() => typeInto(surface, "Hello"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save document" });
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "Documents" } });
    fireEvent.change(within(dialog).getByLabelText("File name"), { target: { value: "hello" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveState()).toBe("Saved"));
    expect(bridge.files.has("Documents/hello.docx")).toBe(true);
    expect(titleText()).toContain("hello.docx");
  });
});
