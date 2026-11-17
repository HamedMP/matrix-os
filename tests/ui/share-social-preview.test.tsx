// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteRecord, SiteSocialSettings } from "@matrix-os/contracts";
import { SocialPreviewSection, type ShareSocialClient } from "../../packages/ui/src/share/index";
import { createSiteClient, type SiteTransport } from "../../shell/src/lib/site-client";

// Outcome: on the Public tab of the Share popover (Web Canvas, Web Desktop,
// Electron Desktop and Web Mobile share this component), the owner sees how a
// shared link will unfurl and can override its title, description and image.
// Faults detected: no fallback to the site details, sending blank strings
// instead of clearing overrides, previewing an image URL outside the active
// build, showing the editor for link-gated sites, and a broken section when the
// platform does not offer the resource yet.

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const site: SiteRecord = {
  id: SITE_ID, appSlug: "launch", title: "Launch party", description: "Join us on Friday", slug: "launch-party",
  url: "https://matrix.page/launch-party", revision: 3, status: "published", accessMode: "public",
  activeVersion: VERSION, versions: [], config: { data: {}, forms: [] },
};
const defaults: SiteSocialSettings = { title: null, description: null, imagePath: null, imageOptions: ["og/card.png", "photo.jpg"] };

function client(overrides: Partial<ShareSocialClient> = {}) {
  return {
    social: vi.fn(async () => defaults),
    updateSocial: vi.fn(async (_app: string, value: { title: string | null; description: string | null; imagePath: string | null }) => ({ ...defaults, ...value })),
    ...overrides,
  };
}
const open = () => fireEvent.click(screen.getByRole("button", { name: /link preview/i }));
afterEach(cleanup);

describe("SocialPreviewSection", () => {
  it("previews the site title and description by default", async () => {
    const api = client();
    render(<SocialPreviewSection appSlug="launch" client={api} site={site} />);
    expect(api.social).not.toHaveBeenCalled();
    open();
    const card = await screen.findByRole("figure", { name: "Link preview" });
    expect(card.textContent).toContain("Launch party");
    expect(card.textContent).toContain("Join us on Friday");
    expect(card.textContent).toContain("matrix.page");
    expect(card.querySelector("img")).toBeNull();
    expect((screen.getByLabelText("Preview title") as HTMLInputElement).placeholder).toBe("Launch party");
  });

  it("saves trimmed overrides and clears blank fields to the defaults", async () => {
    const api = client({ social: vi.fn(async () => ({ ...defaults, title: "Old", description: "Old text" })) });
    render(<SocialPreviewSection appSlug="launch" client={api} site={site} />);
    open();
    fireEvent.change(await screen.findByLabelText("Preview title"), { target: { value: "  Party tonight " } });
    fireEvent.change(screen.getByLabelText("Preview description"), { target: { value: "   " } });
    expect((await screen.findByRole("figure", { name: "Link preview" })).textContent).toContain("Party tonight");
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(api.updateSocial).toHaveBeenCalledWith("launch", { title: "Party tonight", description: null, imagePath: null }, expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Preview saved.");
  });

  it("shows a chosen build image from matrix.page in the card", async () => {
    const api = client({ social: vi.fn(async () => ({ ...defaults, imagePath: "og/card.png" })) });
    render(<SocialPreviewSection appSlug="launch" client={api} site={site} />);
    open();
    const card = await screen.findByRole("figure", { name: "Link preview" });
    expect(card.querySelector("img")?.getAttribute("src")).toBe(`https://matrix.page/${SITE_ID}/assets/${VERSION}/og/card.png`);
  });

  it("explains how to add an image when the build has none", async () => {
    render(<SocialPreviewSection appSlug="launch" client={client({ social: vi.fn(async () => ({ ...defaults, imageOptions: [] })) })} site={site} />);
    open();
    expect(await screen.findByText(/add a png, jpeg or webp file/i)).toBeTruthy();
  });

  it("renders nothing for link-gated or unpublished sites", () => {
    const { container, rerender } = render(<SocialPreviewSection appSlug="launch" client={client()} site={{ ...site, accessMode: "private_link" }} />);
    expect(container.innerHTML).toBe("");
    rerender(<SocialPreviewSection appSlug="launch" client={client()} site={{ ...site, status: "unpublished" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a safe message when settings cannot load", async () => {
    const failure = Object.assign(new Error("postgres://secret"), { status: 404 });
    render(<SocialPreviewSection appSlug="launch" client={client({ social: vi.fn(async () => { throw failure; }) })} site={site} />);
    open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Link preview settings aren’t available yet.");
    expect(screen.queryByRole("button", { name: "Save preview" })).toBeNull();
  });
});

describe("shell site client social methods", () => {
  it("uses the owner social resource and rejects unsafe values both ways", async () => {
    const transport = { get: vi.fn(async () => defaults), patch: vi.fn(async () => ({ ...defaults, imagePath: "photo.jpg" })) } as unknown as SiteTransport;
    const api = createSiteClient(transport);
    const signal = new AbortController().signal;
    expect(await api.social("launch", signal)).toEqual(defaults);
    expect(await api.updateSocial("launch", { title: null, description: null, imagePath: "photo.jpg" }, signal)).toMatchObject({ imagePath: "photo.jpg" });
    expect(transport.get).toHaveBeenCalledWith("/api/apps/launch/site/social", { signal });
    expect(transport.patch).toHaveBeenCalledWith("/api/apps/launch/site/social", { title: null, description: null, imagePath: "photo.jpg" }, { signal });
    await expect(api.updateSocial("launch", { title: null, description: null, imagePath: "https://evil.example/x.png" }, signal)).rejects.toThrow();
    expect(transport.patch).toHaveBeenCalledTimes(1);
    vi.mocked(transport.get).mockResolvedValueOnce({ ...defaults, imageOptions: ["logo.svg"] });
    await expect(api.social("launch", signal)).rejects.toThrow();
  });
});
