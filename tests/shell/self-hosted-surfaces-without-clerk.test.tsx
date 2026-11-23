// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Outcome: a self-hosted computer renders without ClerkProvider, so every
// reachable surface and route must either work with the standalone identity or
// say the hosted-only feature is unavailable. Fault detected: any of these paths
// calling Clerk directly crashes the page (ENG-514).
// The flag is set before any shell module loads, exactly as the root layout's
// data-matrix-self-hosted attribute is present before the client bundle runs.
const search = vi.hoisted(() => {
  document.documentElement.dataset.matrixSelfHosted = "1";
  return { params: new URLSearchParams() };
});

vi.mock("@clerk/nextjs", () => {
  const missingProvider = () => {
    throw new Error("@clerk/react: useAuth can only be used within the <ClerkProvider /> component.");
  };
  return {
    useAuth: missingProvider, useUser: missingProvider, useClerk: missingProvider,
    useOrganization: missingProvider, useOrganizationList: missingProvider,
    SignIn: missingProvider, SignUp: missingProvider, RedirectToSignIn: missingProvider,
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => search.params,
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
}));
// Outside a Next request there is no connection to wait for.
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection: async () => {} }));
vi.mock("../../shell/src/components/settings/sections/AgentSection.js", () => ({
  AgentSection: () => <div>Agents and providers settings</div>,
}));

import { ShellSharedTerminal } from "../../shell/src/components/terminal/ShellSharedTerminal";
import { Settings } from "../../shell/src/components/Settings";
import { RoutineActionCompletion } from "../../shell/src/components/auth/RoutineActionCompletion";
import { BillingGate } from "../../shell/src/components/BillingGate";
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";
import SlackOAuthCompletionPage from "../../shell/src/app/slack/oauth/complete/page";
import RuntimePage from "../../shell/src/app/runtime/page";
import SignInPage from "../../shell/src/app/sign-in/[[...sign-in]]/page";
import SignUpPage from "../../shell/src/app/sign-up/[[...sign-up]]/page";

beforeEach(() => {
  vi.stubEnv("MATRIX_SELF_HOSTED", "1");
  search.params = new URLSearchParams();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("opens a shared terminal link without ClerkProvider and explains that sharing is unavailable", () => {
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
    <ShellSharedTerminal scopeId="10000000-0000-4000-8000-000000000001" />
  </OrganizationStateProvider>);
  expect(screen.queryByText("Shared terminals require an authenticated Matrix account.")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Organization sharing is no longer available");
});

it("opens Settings at Agents & providers when asked for the hosted-only Organization section", () => {
  render(<Settings open onOpenChange={vi.fn()} defaultSection="organization" />);
  expect(screen.getByText("Agents and providers settings")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Organization" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Billing" })).toBeNull();
});

it("reviews a routine CLI confirmation with the standalone identity instead of a Clerk sign-in", () => {
  search.params = new URLSearchParams({ challenge: `rcact_${"a".repeat(32)}` });
  render(<RoutineActionCompletion />);
  expect(screen.queryByText("Checking your Matrix account…")).toBeNull();
  expect(screen.queryByText("This confirmation link is invalid.")).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Confirm one routine operation.");
});

it("explains that adding a computer is hosted-only instead of mounting computer management", () => {
  search.params = new URLSearchParams({ billing: "setup", handoff: "add-computer" });
  render(<BillingGate platformSessionActive><p>desktop</p></BillingGate>);
  expect(screen.getByRole("heading").textContent).toContain("Adding a computer isn't available here.");
});

it.each([
  ["Slack installation", SlackOAuthCompletionPage],
  ["Computer management", RuntimePage],
])("explains that %s is hosted-only on a self-hosted computer", async (feature, Page) => {
  render(await Page());
  expect(screen.getByRole("heading").textContent).toBe(`${feature} isn't available here.`);
  expect(screen.getByRole("link", { name: "Back to your computer" }).getAttribute("href")).toBe("/");
});

it.each([["sign-in", SignInPage], ["sign-up", SignUpPage]])(
  "sends %s back to the computer because self-hosted installs have no Matrix account",
  async (_route, Page) => {
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ url: "/" });
  },
);
