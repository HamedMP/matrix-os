import React from "react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GalleryResults from "../../home/apps/app-gallery/src/GalleryResults";
import AppIdentity from "../../home/apps/app-gallery/src/AppIdentity";
import Preview from "../../home/apps/app-gallery/src/Preview";
import { parseListing } from "../../home/apps/app-gallery/src/model";
import { galleryArtwork } from "../../home/apps/app-gallery/src/artwork";
import catalog from "../../home/system/app-gallery.json";

const apps = parseListing({ version: 1, apps: catalog.apps.slice(0, 4).map(app => ({ ...app, installed: false })) });
function props() {
  return { apps, connections: [], loading: false, error: "", collection: "personal", bridgeUnavailable: false,
    pending: null, actionErrors: {}, onSelect: vi.fn(), onAction: vi.fn(async () => {}), onRefresh: vi.fn(async () => {}), onClear: vi.fn() };
}
afterEach(cleanup);
describe("curated gallery presentation", () => {
  it("keeps each filtered app once across compact preview cards, with working Get and details actions", () => {
    const callbacks = props();
    render(<GalleryResults {...callbacks} />);
    for (const app of apps) expect(screen.getAllByRole("button", { name: `Explore ${app.name}` })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Get" })[0]);
    expect(callbacks.onAction).toHaveBeenCalledWith(apps[0]);
    fireEvent.click(screen.getByRole("button", { name: `Explore ${apps[3].name}` }));
    expect(callbacks.onSelect).toHaveBeenCalledWith(apps[3].id);
    expect(screen.getByRole("region", { name: "Personal apps" })).toBeTruthy();
  });
  it("keeps installed launch and failed-install retry distinct, and disables actions during an install", () => {
    const callbacks = props();
    const current = [{ ...apps[0], installed: true, launchPath: `apps/${apps[0].id}` }, apps[1]];
    const { rerender } = render(<GalleryResults {...callbacks} apps={current} actionErrors={{ [apps[1].id]: "Installation did not finish. Try again." }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(callbacks.onAction).toHaveBeenCalledWith(current[0]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(callbacks.onAction).toHaveBeenCalledWith(current[1]);
    rerender(<GalleryResults {...callbacks} apps={current} pending={apps[1].id} />);
    expect((screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows an actual screenshot for a nonfeatured empty app and labels its workspace accurately", () => {
    const app = apps.find(app => app.id === "agenda")!;
    const { container } = render(<Preview app={app} large />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(galleryArtwork(`previews/${app.id}.png`));
    expect(screen.getByRole("img", { name: `Screenshot of ${app.name}, empty workspace` })).toBeTruthy();
    expect(screen.getByText("App screenshot")).toBeTruthy();
    expect(screen.getByText("Empty workspace")).toBeTruthy();
    expect(screen.queryByText("Example data")).toBeNull();
    expect(screen.queryByText("Layout preview")).toBeNull();
  });
  it("falls back honestly when a screenshot fails and derives board columns from the actual status field", () => {
    const board = apps.find(app => app.view === "board")!;
    const { container, rerender } = render(<Preview app={board} large />);
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(galleryArtwork(`previews/${board.id}.png`));
    fireEvent.error(image!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Layout preview")).toBeTruthy();
    expect(screen.getByText("Starts empty")).toBeTruthy();
    expect(screen.queryByText("App screenshot")).toBeNull();
    expect(screen.queryByText("Example data")).toBeNull();
    for (const label of board.fields.find(field => field.key === "status")?.options?.slice(0, 3) ?? []) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    rerender(<Preview app={apps[0]} large />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(galleryArtwork(`previews/${apps[0].id}.png`));
    expect(screen.getByText("Example data")).toBeTruthy();
    expect(screen.queryByText("Empty workspace")).toBeNull();
  });
});

describe("gallery packaged artwork", () => {
  it("tries the Figma clay icon, PNG, SVG and glyph, resetting for a different app", () => {
    const { container, rerender } = render(<AppIdentity app={apps[0]} />);
    let image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(galleryArtwork(`clay/${apps[0].id}.svg`));
    fireEvent.error(image);
    image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(galleryArtwork(`icons/${apps[0].id}.png`));
    fireEvent.error(image);
    image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(galleryArtwork(`icons/${apps[0].icon}.svg`));
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
    rerender(<AppIdentity app={apps[1]} />);
    image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(galleryArtwork(`clay/${apps[1].id}.svg`));
    fireEvent.error(image);
    image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(galleryArtwork(`icons/${apps[1].id}.png`));
    fireEvent.error(image);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(galleryArtwork(`icons/${apps[1].icon}.svg`));
  });
});
