// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const billingState = vi.hoisted(() => ({
  active: true as boolean | null,
}));

vi.mock("@/hooks/useMatrixBillingAccess", () => ({
  useMatrixBillingAccess: () => ({
    active: billingState.active,
    entitlement: null,
    accessReason: null,
  }),
}));

vi.mock("../../shell/src/components/UserButton.js", () => ({
  UserButton: () => (
    <button type="button" data-testid="settings-clerk-user-button">
      Account menu
    </button>
  ),
}));

vi.mock("../../shell/src/components/settings/sections/AppearanceSection.js", () => ({
  AppearanceSection: () => <div>Appearance settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/AgentSection.js", () => ({
  AgentSection: () => <div>Agent settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/ChannelsSection.js", () => ({
  ChannelsSection: () => <div>Channel settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/IntegrationsSection.js", () => ({
  IntegrationsSection: () => <div>Integration settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/SkillsSection.js", () => ({
  SkillsSection: () => <div>Skill settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/CronSection.js", () => ({
  CronSection: () => <div>Cron settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/SecuritySection.js", () => ({
  SecuritySection: () => <div>Security settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/PluginsSection.js", () => ({
  PluginsSection: () => <div>Plugin settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/SystemSection.js", () => ({
  SystemSection: () => <div>System settings</div>,
}));
vi.mock("../../shell/src/components/settings/sections/BillingSection.js", () => ({
  BillingSection: ({ mode }: { mode?: string }) => (
    <div>Billing settings {mode ?? "settings"}</div>
  ),
}));

describe("Settings panel", () => {
  beforeEach(() => {
    billingState.active = true;
  });

  it("renders the Clerk account button in the settings navigation footer", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(<Settings open onOpenChange={() => {}} />);

    const accountRegion = screen.getByRole("region", { name: "Account" });
    await waitFor(() => expect(accountRegion).toBeVisible());
    expect(screen.getByTestId("settings-clerk-user-button")).toBeVisible();
    expect(accountRegion.className).toContain("sm:mt-auto");
  });

  it("keeps account controls available while billing is locked for provisioning", async () => {
    billingState.active = false;
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(
      <Settings
        open
        onOpenChange={() => {}}
        lockedSection="billing"
        closeDisabled
        billingActiveOverride={false}
        billingMode="provisioning"
      />,
    );

    expect(screen.getByText("Billing settings provisioning")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Account" })).toBeVisible(),
    );
    expect(screen.getByTestId("settings-clerk-user-button")).toBeVisible();
  });

  it("keeps the account footer visible outside the desktop navigation scroll area", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(<Settings open onOpenChange={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const accountRegion = screen.getByRole("region", { name: "Account" });
    expect(nav).not.toContainElement(accountRegion);
    expect(nav.className).toContain("sm:overflow-y-auto");
    expect(accountRegion.className).toContain("sticky");
    expect(accountRegion.className).toContain("sm:static");
  });
});
