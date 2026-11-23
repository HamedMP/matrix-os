// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { docxFromMarkdown, docxFromParagraphs, findSurface, installBridge, renderApp, typeInto } from "./harness";

afterEach(cleanup);

const CONTRACT = [
  "# Definitions",
  "",
  '"Agreement" means this agreement between the parties.',
  "",
  "The Agreement starts today.",
  "",
  "1. Scope of work",
  "2. Payment terms as in Clause 1 apply.",
  "",
  "# Term",
  "",
  "Ends when Clause 9 says so.",
].join("\n");

async function openContract() {
  const bridge = installBridge({ "contract.docx": await docxFromMarkdown(CONTRACT) }, { pending: "contract.docx" });
  renderApp();
  const surface = await findSurface();
  return { bridge, surface };
}

describe("Docs find and replace", () => {
  it("highlights matches, steps through them and replaces", async () => {
    installBridge({ "plan.docx": await docxFromParagraphs(["cat dog cat", "a cat"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    fireEvent.keyDown(surface, { key: "h", ctrlKey: true });
    const bar = await screen.findByRole("search", { name: "Find and replace" });
    fireEvent.change(within(bar).getByLabelText("Find"), { target: { value: "cat" } });
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 3"));
    await waitFor(() => expect(surface.querySelectorAll(".doc-hl-search")).toHaveLength(3));
    expect(surface.querySelectorAll(".doc-hl-search.is-current")).toHaveLength(1);

    fireEvent.click(within(bar).getByRole("button", { name: "Next match" }));
    expect(within(bar).getByTestId("find-count").textContent).toBe("2 of 3");
    fireEvent.click(within(bar).getByRole("button", { name: "Previous match" }));
    expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 3");

    fireEvent.change(within(bar).getByLabelText("Replace with"), { target: { value: "fox" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(surface.textContent).toBe("fox dog cata cat"));
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 2"));
    fireEvent.click(within(bar).getByRole("button", { name: "Replace all" }));
    await waitFor(() => expect(surface.textContent).toBe("fox dog foxa fox"));
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("No results"));

    fireEvent.keyDown(within(bar).getByLabelText("Find"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("search", { name: "Find and replace" })).toBeNull());
    expect(surface.querySelectorAll(".doc-hl-search")).toHaveLength(0);
  });

  it("matches whole words and case on request", async () => {
    installBridge({ "plan.docx": await docxFromParagraphs(["Cat cat catalog"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    fireEvent.keyDown(surface, { key: "f", ctrlKey: true });
    const bar = await screen.findByRole("search", { name: "Find and replace" });
    fireEvent.change(within(bar).getByLabelText("Find"), { target: { value: "cat" } });
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 3"));
    fireEvent.click(within(bar).getByLabelText("Whole words"));
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 2"));
    fireEvent.click(within(bar).getByLabelText("Match case"));
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 1"));
  });
});

describe("Docs outline", () => {
  it("lists headings and clauses, scrolls to one on click and marks the current position", async () => {
    await openContract();
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    const items = within(outline).getAllByRole("button");
    expect(items.map((item) => item.textContent)).toEqual(["Definitions", "1.Scope of work", "2.Payment terms as in Clause 1 apply.", "Term"]);
    fireEvent.click(within(outline).getByRole("button", { name: /Term$/ }));
    await waitFor(() => expect(within(outline).getByRole("button", { name: /Term$/ }).getAttribute("aria-current")).toBe("location"));
    expect(within(outline).getByRole("button", { name: /Definitions/ }).getAttribute("aria-current")).toBeNull();
  });
});

describe("Docs defined terms and cross-references", () => {
  it("shows a definition when hovering a defined term and jumps to it with a way back", async () => {
    const { surface } = await openContract();
    await waitFor(() => expect(surface.querySelectorAll(".doc-hl-terms").length).toBeGreaterThan(0));
    const use = surface.querySelector(".doc-hl-terms") as HTMLElement;
    expect(use.textContent).toBe("Agreement");
    fireEvent.mouseOver(use);
    const card = await screen.findByRole("dialog", { name: /Agreement/ });
    expect(card.textContent).toContain("means this agreement between the parties.");

    fireEvent.click(use);
    const back = await screen.findByRole("button", { name: /Back/ });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Outline" }).querySelector("[aria-current='location']")?.textContent).toBe("Definitions"));
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Back/ })).toBeNull());
  });

  it("previews the referenced clause and reports a broken reference", async () => {
    const { surface } = await openContract();
    await waitFor(() => expect(surface.querySelectorAll(".doc-hl-xrefs")).toHaveLength(2));
    const [good, broken] = [...surface.querySelectorAll(".doc-hl-xrefs")] as HTMLElement[];
    fireEvent.mouseOver(good!);
    const card = await screen.findByRole("dialog", { name: /Clause 1/ });
    expect(card.textContent).toContain("Scope of work");
    fireEvent.mouseOut(good!, { relatedTarget: document.body });
    fireEvent.mouseOver(broken!);
    const missing = await screen.findByRole("dialog", { name: /Clause 9/ });
    expect(missing.textContent).toMatch(/not found/i);

    fireEvent.click(good!);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Outline" }).querySelector("[aria-current='location']")?.textContent).toBe("1.Scope of work"));
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
  });
});

describe("Docs toolbar and status bar", () => {
  it("counts words, toggles tracking and switches the view", async () => {
    const { surface } = await openContract();
    const status = screen.getByRole("contentinfo");
    await waitFor(() => expect(status.textContent).toMatch(/\d+ words/));
    expect(status.textContent).toMatch(/0 revisions/);
    const track = screen.getByRole("button", { name: "Track changes" });
    expect(track.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(track);
    expect(track.getAttribute("aria-pressed")).toBe("true");
    act(() => typeInto(surface, "Z"));
    await waitFor(() => expect(status.textContent).toMatch(/1 revision(?!s)/));

    fireEvent.click(screen.getByRole("button", { name: /^View: All markup/ }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Final" }));
    await waitFor(() => expect(document.querySelector(".doc-page")?.getAttribute("data-view-mode")).toBe("final"));
    expect(screen.getByRole("button", { name: /^View: Final/ })).toBeTruthy();
  });
});
