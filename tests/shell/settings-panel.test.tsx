// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering.js";

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
    vi.resetModules();
    billingState.active = true;
  });

  it("renders the Clerk account button in the settings navigation footer", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(<Settings open onOpenChange={() => {}} />);

    const accountRegion = screen.getByRole("region", { name: "Account" });
    await waitFor(() => expect(accountRegion.isConnected).toBe(true));
    expect(screen.getByTestId("settings-clerk-user-button").isConnected).toBe(true);
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
      expect(screen.getByRole("region", { name: "Account" }).isConnected).toBe(true),
    );
    expect(screen.getByTestId("settings-clerk-user-button").isConnected).toBe(true);
  });

  it("keeps the account footer visible outside the desktop navigation scroll area", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(<Settings open onOpenChange={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const accountRegion = screen.getByRole("region", { name: "Account" });
    expect(nav.contains(accountRegion)).toBe(false);
    expect(nav.className).toContain("sm:overflow-y-auto");
    expect(accountRegion.className).toContain("sticky");
    expect(accountRegion.className).toContain("sm:static");
  });

  it("renders above fullscreen app windows while staying below hard gates and shell notifications", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(<Settings open onOpenChange={() => {}} />);

    const settingsLayer = screen.getByLabelText("Close settings").parentElement;
    expect(settingsLayer).toBeTruthy();

    const settingsZ = Number(settingsLayer?.style.zIndex);
    expect(settingsZ).toBe(SHELL_Z_INDEX.settings);
    expect(settingsZ).toBeGreaterThan(SHELL_Z_INDEX.fullscreenExit);
    expect(settingsZ).toBeLessThan(SHELL_Z_INDEX.hardGate);
    expect(settingsZ).toBeLessThan(SHELL_Z_INDEX.notifications);
  });

  it("renders the onboarding default installs step inside Settings with pre-VPS sections disabled", async () => {
    const onBuild = vi.fn();
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(
      <Settings
        open
        onOpenChange={() => {}}
        closeDisabled
        billingActiveOverride
        onboardingDefaultInstalls={{ onBuild, loading: false, error: null }}
      />,
    );

    const defaultInstallsTab = screen.getByRole("button", { name: "Default installs" });
    expect(defaultInstallsTab.getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("button", { name: "Billing Completed" }) as HTMLButtonElement).disabled).toBe(true);
    for (const label of ["Appearance", "Integrations", "System"]) {
      expect((screen.getByRole("button", { name: `${label} Unavailable until your VPS is ready` }) as HTMLButtonElement).disabled).toBe(true);
    }

    for (const label of ["Codex", "Claude Code", "OpenCode", "Pi"]) {
      const checkbox = screen.getByRole("checkbox", { name: label });
      expect((checkbox as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText(label).classList.contains("truncate")).toBe(false);
      fireEvent.click(checkbox);
    }

    fireEvent.click(screen.getByRole("button", { name: "Build VPS" }));
    expect(onBuild).toHaveBeenCalledWith([]);
    expect(screen.getByTestId("settings-clerk-user-button").isConnected).toBe(true);
  });

  it("keeps the chooser visible and disables only the build controls while provisioning", async () => {
    const { Settings } = await import("../../shell/src/components/Settings.js");

    render(
      <Settings
        open
        onOpenChange={() => {}}
        closeDisabled
        billingActiveOverride
        onboardingDefaultInstalls={{ onBuild: vi.fn(), loading: true, error: null }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Default installs" }).isConnected).toBe(true);
    const buildButton = screen.getByRole("button", { name: "Build VPS" });
    expect((buildButton as HTMLButtonElement).disabled).toBe(true);
    expect(buildButton.getAttribute("aria-busy")).toBe("true");
    expect(buildButton.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByText(/Starting|Preparing|Loading/i)).toBeNull();
  });
});
