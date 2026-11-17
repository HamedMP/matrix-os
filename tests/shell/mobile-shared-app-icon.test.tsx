// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileAppIcon } from "../../shell/src/components/mobile/MobileAppIcon";
import { MobileLauncher } from "../../shell/src/components/mobile/MobileLauncher";
import type { MobileApp } from "../../shell/src/components/mobile/mobile-app";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sharedTarget = {
  scopeId,
  runtimeId: "vps:20000000-0000-4000-8000-000000000001",
  organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
  owner: { actorId: "user_owner", displayName: "Owner" }, name: "Team Tracker",
  iconUrl: `/api/collaboration/shared-apps/${scopeId}/icon?v=${"c".repeat(64)}`,
};

function renderLauncher(apps: MobileApp[]) {
  return render(
    <MobileLauncher apps={apps} onOpen={() => undefined} onOpenSettings={() => undefined}
      openStackCount={0} onShowSwitcher={() => undefined} onCloseAll={() => undefined} />,
  );
}

afterEach(() => cleanup());

describe("Web Mobile shared app icons", () => {
  // Fault: an unloadable owner icon (extensionless platform route) fell back to the Matrix logo,
  // which reads as a Matrix system app instead of the shared app Web/Electron Desktop show.
  it("falls back to the app's initial tile, not the Matrix logo, when the owner icon fails", () => {
    renderLauncher([{
      id: `__shared-app__:${scopeId}`, name: "Team Tracker", path: `__shared-app__:${scopeId}`,
      iconSlug: "apps", iconUrl: sharedTarget.iconUrl, sharedAppTarget: sharedTarget,
    }]);
    const tile = screen.getByTestId(`mobile-launcher-app-__shared-app__:${scopeId}`);
    const img = tile.querySelector("img");
    expect(img?.getAttribute("src")).toBe(sharedTarget.iconUrl);
    fireEvent.error(img!);
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.innerHTML).not.toContain("/icon-192.png");
    expect(screen.getByTestId("mobile-app-icon-initial").textContent).toBe("T");
  });

  // Fault: failure state outlived the selected URL, so returning to a once-failed icon never retried it.
  it("retries a previously failed icon when the selected URL changes back to it", () => {
    const iconA = sharedTarget.iconUrl;
    const iconB = `/api/collaboration/shared-apps/${scopeId}/icon?v=${"d".repeat(64)}`;
    const { container, rerender } = render(<MobileAppIcon slug="apps" iconUrl={iconA} size={48} fallbackName="Team Tracker" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<MobileAppIcon slug="apps" iconUrl={iconB} size={48} fallbackName="Team Tracker" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(iconB);
    rerender(<MobileAppIcon slug="apps" iconUrl={iconA} size={48} fallbackName="Team Tracker" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(iconA);
  });

  it("keeps the Matrix logo as the last fallback for ordinary apps", () => {
    renderLauncher([{ id: "notes", name: "Notes", path: "apps/notes/index.html", iconSlug: "notes", iconUrl: "/icons/notes.png" }]);
    const tile = screen.getByTestId("mobile-launcher-app-apps/notes/index.html");
    fireEvent.error(tile.querySelector("img")!);
    expect(tile.querySelector("img")?.getAttribute("src")).toBe("/icons/notes.svg");
    fireEvent.error(tile.querySelector("img")!);
    expect(tile.querySelector("img")?.getAttribute("src")).toBe("/icon-192.png");
  });
});
