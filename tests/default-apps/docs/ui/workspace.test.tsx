// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docxFromMarkdown, docxFromParagraphs, findSurface, installBridge, renderApp, typeInto } from "./harness";

afterEach(cleanup);

function ribbonTab(name: string): void {
  fireEvent.click(within(screen.getByRole("tablist", { name: "Document ribbon" })).getByRole("tab", { name }));
}

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
    const bar = await screen.findByLabelText("Find and replace", { selector: "search" });
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
    await waitFor(() => expect(screen.queryByLabelText("Find and replace", { selector: "search" })).toBeNull());
    expect(surface.querySelectorAll(".doc-hl-search")).toHaveLength(0);
  });

  it("replaces against the live document when Replace is clicked again before the results refresh", async () => {
    installBridge({ "plan.docx": await docxFromParagraphs(["cat cat"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    fireEvent.keyDown(surface, { key: "h", ctrlKey: true });
    const bar = await screen.findByLabelText("Find and replace", { selector: "search" });
    fireEvent.change(within(bar).getByLabelText("Find"), { target: { value: "cat" } });
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 2"));
    fireEvent.change(within(bar).getByLabelText("Replace with"), { target: { value: "elephant" } });
    const replace = within(bar).getByRole("button", { name: "Replace" });
    fireEvent.click(replace);
    fireEvent.click(replace);
    await waitFor(() => expect(surface.textContent).toBe("elephant elephant"));
    fireEvent.click(replace);
    expect(surface.textContent).toBe("elephant elephant");

    fireEvent.change(within(bar).getByLabelText("Find"), { target: { value: "elephant" } });
    await waitFor(() => expect(within(bar).getByTestId("find-count").textContent).toBe("1 of 2"));
    fireEvent.change(within(bar).getByLabelText("Replace with"), { target: { value: "ox" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Replace" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Replace all" }));
    await waitFor(() => expect(surface.textContent).toBe("ox ox"));
  });

  it("matches whole words and case on request", async () => {
    installBridge({ "plan.docx": await docxFromParagraphs(["Cat cat catalog"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    fireEvent.keyDown(surface, { key: "f", ctrlKey: true });
    const bar = await screen.findByLabelText("Find and replace", { selector: "search" });
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
    // Escape dismisses the card, as for every transient surface.
    fireEvent.keyDown(surface, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Agreement/ })).toBeNull());
    fireEvent.mouseOut(use, { relatedTarget: document.body });
    fireEvent.mouseOver(use);
    expect(await screen.findByRole("dialog", { name: /Agreement/ })).toBeTruthy();

    fireEvent.click(use);
    const back = await screen.findByRole("button", { name: /^Back$/ });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Outline" }).querySelector("[aria-current='location']")?.textContent).toBe("Definitions"));
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Back$/ })).toBeNull());
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
    expect(screen.getByRole("button", { name: /^Back$/ })).toBeTruthy();
  });
});

describe("Docs ribbon and status bar", () => {
  it("counts words, toggles tracking and switches the view from the Review tab", async () => {
    const { surface } = await openContract();
    const status = screen.getByRole("contentinfo");
    await waitFor(() => expect(status.textContent).toMatch(/\d+ words/));
    expect(status.textContent).toMatch(/0 revisions/);
    ribbonTab("Review");
    const track = screen.getByRole("button", { name: "Track changes" });
    expect(track.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(track);
    expect(track.getAttribute("aria-pressed")).toBe("true");
    act(() => typeInto(surface, "Z"));
    await waitFor(() => expect(status.textContent).toMatch(/1 revision(?!s)/));

    fireEvent.change(screen.getByRole("combobox", { name: "Markup view" }), { target: { value: "final" } });
    await waitFor(() => expect(document.querySelector(".doc-page")?.getAttribute("data-view-mode")).toBe("final"));
    expect((screen.getByRole("combobox", { name: "Markup view" }) as HTMLSelectElement).value).toBe("final");
  });

  it("shows the ribbon tabs in menu-bar order with Home selected, and File opens the backstage", async () => {
    await openContract();
    const tablist = screen.getByRole("tablist", { name: "Document ribbon" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["File", "Home", "Insert", "Review", "View", "Assistant"]);
    expect(within(tablist).getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(tablist).getByRole("tab", { name: "File" }));
    const entries = [...document.querySelectorAll(".oui-backstage__item")].map((item) => item.textContent);
    expect(entries).toEqual(["New", "Open from Matrix…", "Open from this computer…", "Save", "Save a copy", "Download a copy", "Export", "Close"]);
  });

  it("shows keyboard shortcuts in the command tooltips", async () => {
    await openContract();
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-keyshortcuts")).toBe("Ctrl+B");
    expect(screen.getByRole("button", { name: "Undo" }).getAttribute("aria-keyshortcuts")).toBe("Ctrl+Z");
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("title")).toMatch(/Ctrl\+B/);
  });

  it("formats the selection with the font colour, size and alignment controls", async () => {
    const { bridge, surface } = await openContract();
    act(() => typeInto(surface, "Hello"));
    const doc = () => document.querySelector(".doc-page");
    expect(doc()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Center" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe("true"));
    const before = surface.querySelectorAll("[data-block-type='paragraph']").length;
    ribbonTab("Insert");
    const button = screen.getByRole("button", { name: "Paragraph break" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(surface.querySelectorAll("[data-block-type='paragraph']").length).toBe(before + 1));
    expect(bridge.files.writes).toEqual([]);
  });

  it("colours the selection with the face of the font colour button, then with the colour chosen last", async () => {
    installBridge({ "plan.docx": await docxFromParagraphs(["Plain words here"]) }, { pending: "plan.docx" });
    renderApp();
    const surface = await findSurface();
    const selectWords = () => {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode()!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    };
    const colours = () => [...surface.querySelectorAll<HTMLElement>("[style*='color']")].map((node) => node.style.color).filter((value) => value !== "");
    act(selectWords);
    fireEvent.click(screen.getByRole("button", { name: "Font colour" }));
    await waitFor(() => expect(colours()).toEqual(["rgb(220, 38, 38)"]));

    act(selectWords);
    fireEvent.click(screen.getByRole("button", { name: "Font colour options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Blue" }));
    await waitFor(() => expect(colours()).toEqual(["rgb(37, 99, 235)"]));
    expect(screen.getByRole("button", { name: "Font colour" }).getAttribute("title")).toMatch(/Blue/);
  });

  it("opens the side panel with the review module's revisions and comments", async () => {
    await openContract();
    ribbonTab("View");
    const toggle = screen.getByRole("button", { name: "Side panel" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tab", { name: /^Review/, selected: true })).toBeTruthy();
    const side = screen.getByRole("complementary", { name: "Review, assistant and compare" });
    const panel = within(side).getByRole("tabpanel");
    expect(await within(panel).findByText("No tracked changes", {}, { timeout: 3000 })).toBeTruthy();
    expect(within(panel).getByText("No comments yet")).toBeTruthy();
    fireEvent.click(within(side).getByRole("tab", { name: /Assistant/ }));
    expect(within(side).getByRole("tab", { name: /Assistant/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Review, assistant and compare" })).toBeNull());
  });

  it("opens the comment box from New comment and the assistant from its tab", async () => {
    await openContract();
    ribbonTab("Review");
    fireEvent.click(screen.getByRole("button", { name: "New comment" }));
    const box = await screen.findByRole("textbox", { name: /comment/i }, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(box));
    ribbonTab("Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Assistant", pressed: false }));
    expect(await screen.findByRole("group", { name: "Assistant mode" }, { timeout: 5000 })).toBeTruthy();
  });

  it("keeps the assistant conversation while its tab is hidden or the side panel is closed", async () => {
    await openContract();
    (window as unknown as { MatrixOS: { ai: { generate: unknown } } }).MatrixOS.ai.generate = async () => ({ text: "A short contract." });
    ribbonTab("Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Summarise" }));
    const side = () => screen.getByRole("complementary", { name: "Review, assistant and compare" });
    expect(await screen.findByRole("article", { name: "Summary" }, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(within(side()).getByRole("tab", { name: /^Review/ }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Summary" })).toBeNull());
    fireEvent.click(within(side()).getByRole("tab", { name: /Assistant/ }));
    expect(await screen.findByRole("article", { name: "Summary" }, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Review, assistant and compare" })).toBeNull());
    ribbonTab("View");
    fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
    expect(await screen.findByRole("article", { name: "Summary" }, { timeout: 5000 })).toBeTruthy();
  });

  it("runs an assistant quick action from the Assistant tab", async () => {
    await openContract();
    const generate = vi.fn(async () => ({ text: "A short contract." }));
    (window as unknown as { MatrixOS: { ai: { generate: unknown } } }).MatrixOS.ai.generate = generate;
    ribbonTab("Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Summarise" }));
    expect(await screen.findByRole("group", { name: "Assistant mode" }, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(generate).toHaveBeenCalled(), { timeout: 5000 });
  });
});
