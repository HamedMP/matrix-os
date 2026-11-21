// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SharedAppOpenPage from "../../shell/src/app/open/shared-app/[scopeId]/page";
import { SharedAppHandoff } from "../../shell/src/components/shared-app/SharedAppHandoff";
import { inlineScriptString } from "../../shell/src/components/shared-app/shared-app-launch";
import { isPublicShellPath } from "../../shell/src/lib/proxy-routes";
import { organizationColor } from "../../packages/ui/src/share/organization-identity";

// Outcome: an org link opened in a browser hands off to the desktop app once the
// HTML is parsed, with clear fallbacks. Faults: the attempt waiting for
// hydration, repeated attempts, display hints leaking into the desktop link,
// unvalidated input reaching the inline script, the badge colour differing
// from the member launcher, or the page requiring a session.

const SCOPE = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "org_2abcDEF123";
const DESKTOP_URL = `matrixos://shared-app/${SCOPE}?expectedShareRevision=3`;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderPage(search: Record<string, string>, scopeId = SCOPE): Promise<string> {
  const element = await SharedAppOpenPage({ params: Promise.resolve({ scopeId }), searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element);
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

function cssColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.background = value;
  return probe.style.background;
}

describe("org link hand-off page", () => {
  it("opens the desktop app from server-rendered HTML once the document is parsed, not after hydration", async () => {
    const html = await renderPage({ expectedShareRevision: "3", app: "Sales CRM", org: "Finna", orgId: ORG_ID });
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(1);
    const assign = vi.fn();
    const listeners: Array<{ type: string; listener: () => void; options: unknown }> = [];
    const fakeDocument = { addEventListener: (type: string, listener: () => void, options: unknown) => listeners.push({ type, listener, options }) };
    new Function("window", "document", scripts[0]!)({ location: { assign } }, fakeDocument);
    // Fault: navigating mid-parse aborted the document in some browsers, leaving no fallback buttons.
    expect(assign).not.toHaveBeenCalled();
    expect(listeners).toEqual([{ type: "DOMContentLoaded", listener: expect.any(Function), options: { once: true } }]);
    listeners[0]!.listener();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(DESKTOP_URL);
    expect(scripts[0]).not.toContain("Sales");
    expect(scripts[0]).not.toContain("Finna");
    expect(scripts[0]).not.toContain(ORG_ID);
  });

  it("renders nothing for a link that fails strict validation", async () => {
    await expect(renderPage({}, "</script><script>alert(1)</script>")).rejects.toThrow();
    await expect(renderPage({ expectedShareRevision: "3", extra: "x" })).rejects.toThrow();
    await expect(renderPage({ orgId: "</script>" })).rejects.toThrow();
  });

  it("escapes values so they can never close the inline script", () => {
    const encoded = inlineScriptString("</script><!--\u2028\u2029&");
    expect(encoded).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(encoded)).toBe("</script><!--\u2028\u2029&");
  });

  it("leaves the attempt to the inline script and offers Open in Matrix and Download Matrix", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const link = { scopeId: SCOPE, expectedShareRevision: "3", app: "Sales CRM", org: "Finna" };
    render(<SharedAppHandoff link={link} downloadUrl="https://matrix-os.com" />);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Sales CRM" })).toBeTruthy();
    expect(screen.getByText("Shared in Finna")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Opening in the Matrix app…");
    expect(screen.getByRole("link", { name: /Open in Matrix/ }).getAttribute("href")).toBe(DESKTOP_URL);
    expect(screen.getByRole("link", { name: "Download Matrix" }).getAttribute("href")).toBe("https://matrix-os.com");
    expect(screen.queryByRole("link", { name: "Open in Canary" })).toBeNull();
    expect(screen.queryByText(/Matrix Canary/)).toBeNull();
    expect(screen.getByText("Only Finna members can open this app.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Sales CRM — shared from Finna" })).toBeTruthy();
  });

  it("colours the org badge from the organization id, like the member launcher", () => {
    // Precondition: the name and the id hash to different colours, so the test can tell them apart.
    expect(organizationColor(ORG_ID)).not.toBe(organizationColor("Finna"));
    const link = { scopeId: SCOPE, app: "Sales CRM", org: "Finna", orgId: ORG_ID };
    render(<SharedAppHandoff link={link} downloadUrl="https://matrix-os.com" />);
    const badge = screen.getByRole("img", { name: "Sales CRM — shared from Finna" });
    expect(badge.style.background).toBe(cssColor(organizationColor(ORG_ID)));
  });

  it("is reachable without a session and only for a scope-shaped path", () => {
    expect(isPublicShellPath(`/open/shared-app/${SCOPE}`)).toBe(true);
    expect(isPublicShellPath("/open/shared-app/../settings")).toBe(false);
    expect(isPublicShellPath(`/shared/app/${SCOPE}`)).toBe(false);
  });
});
