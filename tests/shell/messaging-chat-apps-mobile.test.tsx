// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const stub = (name: string) => ({ [name]: () => null, default: () => null });
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", sessionId: "synthetic-session", getToken: async () => "synthetic-token" }) }));
vi.mock("@/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => false }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock("@/hooks/useMatrixBillingAccess", () => ({ useMatrixBillingAccess: () => ({ active: true }) }));
vi.mock("@/components/UserButton", () => stub("UserButton"));
vi.mock("@/components/settings/sections/AppearanceSection", () => stub("AppearanceSection"));
vi.mock("@/components/settings/sections/AgentSection", () => stub("AgentSection"));
vi.mock("@/components/settings/sections/IdentityPersonalitySection", () => stub("IdentityPersonalitySection"));
vi.mock("@/components/settings/sections/ChannelsSection", () => stub("ChannelsSection"));
vi.mock("@/components/settings/sections/IntegrationsSection", () => stub("IntegrationsSection"));
vi.mock("@/components/settings/sections/SkillsSection", () => stub("SkillsSection"));
vi.mock("@/components/settings/sections/CronSection", () => stub("CronSection"));
vi.mock("@/components/settings/sections/SecuritySection", () => stub("SecuritySection"));
vi.mock("@/components/settings/sections/PluginsSection", () => stub("PluginsSection"));
vi.mock("@/components/settings/sections/SystemSection", () => stub("SystemSection"));
vi.mock("@/components/settings/sections/AiUsageSection", () => stub("AiUsageSection"));
vi.mock("@/components/settings/sections/ChatImportSection", () => stub("ChatImportSection"));
vi.mock("@/components/settings/sections/BillingSection", () => stub("BillingSection"));
vi.mock("@/components/settings/sections/OrganizationSection", () => stub("OrganizationSection"));
vi.mock("@/components/onboarding/DefaultInstallsStep", () => stub("DefaultInstallsStep"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderMessagingSettings(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.includes("/api/messages/bridge/status")
      ? Response.json({ availability: "not_enabled", networks: [] })
      : Response.json({ connected: false, admission: "public" }),
  ));
  const { Settings } = await import("../../shell/src/components/Settings");
  render(<Settings open onOpenChange={() => {}} defaultSection="messaging" billingActiveOverride />);
  expect(await screen.findByRole("region", { name: "WhatsApp" })).toBeTruthy();
}

it("hides Your chat apps on Web Mobile while keeping the WhatsApp panel", async () => {
  await renderMessagingSettings(390);
  await screen.findByText("Not connected");
  expect(screen.queryByRole("heading", { name: "Your chat apps" })).toBeNull();
});

it("shows Your chat apps in Web Desktop Settings", async () => {
  await renderMessagingSettings(1280);
  expect(await screen.findByRole("heading", { name: "Your chat apps" })).toBeTruthy();
  expect(await screen.findByText("Not available yet")).toBeTruthy();
});
