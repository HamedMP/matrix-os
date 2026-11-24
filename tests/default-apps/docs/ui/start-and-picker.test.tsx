// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { docxFromParagraphs, findSurface, installBridge, renderApp, titleText, typeInto } from "./harness";

afterEach(cleanup);

describe("Docs start screen", () => {
  it("lists recent documents and opens one", async () => {
    const bridge = installBridge({ "Documents/plan.docx": await docxFromParagraphs(["Plan"]) });
    await bridge.db.insert("recent_documents", { path: "Documents/plan.docx", name: "plan.docx", opened_at: "2026-11-22T10:00:00.000Z" });
    renderApp();
    const recent = await screen.findByRole("button", { name: /plan\.docx/ });
    expect(recent.textContent).toContain("Documents");
    fireEvent.click(recent);
    expect((await findSurface()).textContent).toBe("Plan");
  });

  it("starts a blank document", async () => {
    installBridge({});
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /New blank document/ }));
    const surface = await findSurface();
    expect(surface.textContent).toBe("");
    expect(titleText()).toContain("Untitled");
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
});

describe("Docs open dialog", () => {
  it("browses the home through files.list, shows only folders and .docx files, and opens the chosen file", async () => {
    const bridge = installBridge(
      { "Documents/Legal/msa.docx": await docxFromParagraphs(["Master agreement"]), "top.docx": await docxFromParagraphs(["Top"]) },
      { extraPaths: ["system/config.json", "notes.md", "Documents/budget.xlsx", ".hidden/x.docx"] },
    );
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Open from Matrix/ }));
    const dialog = await screen.findByRole("dialog", { name: "Open a document" });
    await within(dialog).findByRole("button", { name: /top\.docx/ });
    const names = within(dialog)
      .getAllByRole("button", { name: /\.docx|Documents/ })
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names.some((name) => name?.includes("system"))).toBe(false);
    expect(within(dialog).queryByText("notes.md")).toBeNull();
    expect(within(dialog).queryByText(".hidden")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: /Folder Documents/ }));
    await within(dialog).findByRole("button", { name: /Folder Legal/ });
    expect(within(dialog).queryByText("budget.xlsx")).toBeNull();
    expect(bridge.listCalls).toContain("Documents");
    fireEvent.click(within(dialog).getByRole("button", { name: /Folder Legal/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /msa\.docx/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect((await findSurface()).textContent).toBe("Master agreement");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open a document" })).toBeNull());
  });

  it("returns home through the breadcrumb and shows listing failures", async () => {
    const bridge = installBridge({ "Documents/a.docx": await docxFromParagraphs(["A"]) });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Open from Matrix/ }));
    const dialog = await screen.findByRole("dialog", { name: "Open a document" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Folder Documents/ }));
    await within(dialog).findByRole("button", { name: /a\.docx/ });
    bridge.failListOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Home" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/could not be listed/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("button", { name: /Folder Documents/ });
  });
});
