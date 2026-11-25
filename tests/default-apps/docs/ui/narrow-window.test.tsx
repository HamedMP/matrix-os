// @vitest-environment jsdom
/**
 * A narrow window has no room for the outline, a readable page and the side
 * panel together: the side panel takes the outline's place while it is open,
 * the Outline command brings the outline back in place of the panel, and a
 * very narrow window starts without the outline over the page.
 */

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outlineVisible } from "../../../../home/apps/docs/src/ui/pane-layout";
import { docxFromMarkdown, findSurface, installBridge, renderApp } from "./harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Makes `window.matchMedia` answer as a window at most `width` pixels wide. */
function windowWidth(width: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    return { matches: width <= max, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
  });
}

function ribbonTab(name: string): void {
  fireEvent.click(within(screen.getByRole("tablist", { name: "Document ribbon" })).getByRole("tab", { name }));
}

async function openDocument(): Promise<void> {
  installBridge({ "plan.docx": await docxFromMarkdown("# One\n\nText\n\n# Two\n\nMore") }, { pending: "plan.docx" });
  renderApp();
  await findSurface();
}

const outline = () => screen.queryByRole("navigation", { name: "Outline" });
const sidePanel = () => screen.queryByRole("complementary", { name: "Review, assistant and compare" });

describe("Docs panes in a narrow window", () => {
  it("decides when the outline shows", () => {
    expect(outlineVisible(true, true, false)).toBe(true);
    expect(outlineVisible(true, true, true)).toBe(false);
    expect(outlineVisible(true, false, true)).toBe(true);
    expect(outlineVisible(false, false, false)).toBe(false);
  });

  it("keeps the outline and the side panel side by side in a wide window", async () => {
    windowWidth(1400);
    await openDocument();
    ribbonTab("View");
    fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
    expect(outline()).not.toBeNull();
    expect(sidePanel()).not.toBeNull();
  });

  it("gives the outline's room to the side panel, and the panel's room back to the outline", async () => {
    windowWidth(900);
    await openDocument();
    ribbonTab("View");
    const outlineToggle = () => screen.getByRole("button", { name: "Outline" });
    expect(outline()).not.toBeNull();
    expect(outlineToggle().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
    expect(sidePanel()).not.toBeNull();
    expect(outline()).toBeNull();
    expect(outlineToggle().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(outlineToggle());
    await waitFor(() => expect(sidePanel()).toBeNull());
    expect(outline()).not.toBeNull();
    expect(outlineToggle().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    await waitFor(() => expect(outline()).not.toBeNull());
  });

  it("starts without the outline when the window is too narrow to show it beside the page", async () => {
    windowWidth(600);
    await openDocument();
    expect(outline()).toBeNull();
    ribbonTab("View");
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(outline()).not.toBeNull();
  });
});
