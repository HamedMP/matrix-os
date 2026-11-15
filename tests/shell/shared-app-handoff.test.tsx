// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAppHandoff } from "../../shell/src/components/shared-app/SharedAppHandoff";
import { isPublicShellPath } from "../../shell/src/lib/proxy-routes";

// Outcome: an org link opened in a browser hands off to the desktop app with
// clear fallbacks. Faults: no automatic attempt, repeated attempts, display
// hints leaking into the desktop link, or the page requiring a session.

const SCOPE = "10000000-0000-4000-8000-000000000001";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("org link hand-off page", () => {
  it("tries the desktop app once and offers Open in Matrix and Download Matrix", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const link = { scopeId: SCOPE, expectedShareRevision: "3", app: "Sales CRM", org: "Finna" };
    const { rerender } = render(<SharedAppHandoff link={link} downloadUrl="https://matrix-os.com" />);
    rerender(<SharedAppHandoff link={link} downloadUrl="https://matrix-os.com" />);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`matrixos://shared-app/${SCOPE}?expectedShareRevision=3`);
    expect(screen.getByRole("heading", { name: "Sales CRM" })).toBeTruthy();
    expect(screen.getByText("Shared in Finna")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Opening in the Matrix app…");
    expect(screen.getByRole("link", { name: /Open in Matrix/ }).getAttribute("href")).toBe(`matrixos://shared-app/${SCOPE}?expectedShareRevision=3`);
    expect(screen.getByRole("link", { name: "Download Matrix" }).getAttribute("href")).toBe("https://matrix-os.com");
    expect(screen.getByRole("link", { name: "Open in Canary" }).getAttribute("href")).toBe(`matrixos-canary://shared-app/${SCOPE}?expectedShareRevision=3`);
    expect(screen.getByText("Only Finna members can open this app.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Sales CRM — shared from Finna" })).toBeTruthy();
  });

  it("is reachable without a session and only for a scope-shaped path", () => {
    expect(isPublicShellPath(`/open/shared-app/${SCOPE}`)).toBe(true);
    expect(isPublicShellPath("/open/shared-app/../settings")).toBe(false);
    expect(isPublicShellPath(`/shared/app/${SCOPE}`)).toBe(false);
  });
});
