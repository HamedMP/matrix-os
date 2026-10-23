// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationMarketplace } from "../../packages/ui/src/integrations/IntegrationMarketplace.js";
import { buildIntegrationSections, integrationDescription } from "../../packages/contracts/src/integration-marketplace.js";
const services = [
  { id: "gmail", name: "Gmail", category: "google", authType: "oauth" as const },
  { id: "asana", name: "Asana", category: "productivity", authType: "oauth" as const, description: "Read projects and tasks." },
  { id: "stripe", name: "Stripe", category: "finance", authType: "keys" as const },
];
afterEach(cleanup);
describe("integration marketplace", () => {
  it("searches names, descriptions and categories in a shared derivation", () => {
    expect(buildIntegrationSections(services, { query: "tasks" }).flatMap(s => s.services).map(s => s.id)).toEqual(["asana"]);
    expect(buildIntegrationSections(services, { query: "  GMAIL " }).flatMap(s => s.services).map(s => s.id)).toEqual(["gmail"]);
    expect(integrationDescription(services[0])).toContain("email");
  });
  it("surfaces marketing and customer support as discoverable categories", () => {
    const expanded = [{ id: "loops", name: "Loops", category: "communication" }, { id: "zendesk", name: "Zendesk", category: "communication" }, { id: "intercom", name: "Intercom", category: "communication" }];
    expect(buildIntegrationSections(expanded).map(section => [section.title, section.services.map(service => service.id)])).toEqual([["Customer support", ["zendesk", "intercom"]], ["Marketing", ["loops"]]]);
    expect(buildIntegrationSections(expanded, { query: "marketing" })[0]?.services[0]?.id).toBe("loops");
  });
  it("filters OAuth and connected apps without duplicate category rows", () => {
    expect(buildIntegrationSections(services, { oauthOnly: true }).flatMap(s => s.services).map(s => s.id)).not.toContain("stripe");
    expect(buildIntegrationSections(services, { connectedOnly: true, connectedIds: ["gmail"] }).flatMap(s => s.services).map(s => s.id)).toEqual(["gmail"]);
  });
  it("can lead with a section of chosen apps, in that order, without repeating them", () => {
    const sections = buildIntegrationSections(services, { leading: { title: "Suggested for your goals", ids: ["stripe", "gmail", "missing"] } });
    expect(sections.map((section) => [section.title, section.services.map((service) => service.id)]))
      .toEqual([["Suggested for your goals", ["stripe", "gmail"]], ["Productivity", ["asana"]]]);
    expect(buildIntegrationSections(services, { query: "asana", leading: { title: "Suggested for your goals", ids: ["gmail"] } })
      .map((section) => section.title)).toEqual(["Productivity"]);
  });
  it("shows the leading section in full and explains a sign-in that did not finish", () => {
    const onConnect = vi.fn();
    render(<IntegrationMarketplace services={services} connectedIds={[]} failedIds={["gmail"]} onConnect={onConnect}
      leadingSection={{ title: "Suggested for your goals", ids: ["gmail"] }} />);
    expect(screen.getByRole("region", { name: "Suggested for your goals" })).toBeTruthy();
    expect(screen.getByText("Sign-in didn't finish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try connecting Gmail again" }));
    expect(onConnect).toHaveBeenCalledWith("gmail");
  });
  it("can show a connected app as just Connected, without adding another account", () => {
    const view = render(<IntegrationMarketplace services={services} connectedIds={["gmail"]} addAccounts={false} onConnect={vi.fn()} />);
    expect(within(screen.getByTestId("integration-card-gmail")).getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add another Gmail account" })).toBeNull();
    view.rerender(<IntegrationMarketplace services={services} connectedIds={["gmail"]} onConnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add another Gmail account" })).toBeTruthy();
  });
  it("can keep every app connectable while one sign-in is pending", () => {
    const onConnect = vi.fn();
    render(<IntegrationMarketplace services={services} connectedIds={[]} connectingId="gmail" lockWhileConnecting={false} onConnect={onConnect} />);
    expect((screen.getByRole("button", { name: "Connect Asana" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Connect Asana" }));
    expect(onConnect).toHaveBeenCalledWith("asana");
    // The pending one can be started again, e.g. after its window was closed.
    expect((screen.getByRole("button", { name: "Connect Gmail" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("connects in one click with no label form and disables all actions while connecting", () => {
    const onConnect = vi.fn();
    const view = render(<IntegrationMarketplace services={services} connectedIds={[]} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Asana" }));
    expect(onConnect).toHaveBeenCalledWith("asana");
    expect(screen.queryByRole("textbox", { name: "Account label" })).toBeNull();
    view.rerender(<IntegrationMarketplace services={services} connectedIds={[]} connectingId="asana" onConnect={onConnect} />);
    expect((screen.getByRole("button", { name: "Connect Gmail" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("renders real logo URLs, falls back on failure, and retries changed assets", () => {
    const item = { ...services[1], logoUrl: "https://pipedream.com/s.v0/app_OVWhPX/logo/96" };
    const view = render(<IntegrationMarketplace services={[item]} connectedIds={[]} onConnect={vi.fn()} />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(item.logoUrl);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
    view.rerender(<IntegrationMarketplace services={[{ ...item, logoUrl: "https://pipedream.com/s.v0/app_OVWhPX/logo/48" }]} connectedIds={[]} onConnect={vi.fn()} />);
    expect(view.container.querySelector("img")).toBeTruthy();
  });
  it("shows credential requirements, search empty state, and another-account action", () => {
    render(<IntegrationMarketplace services={services} connectedIds={["gmail"]} onConnect={vi.fn()} />);
    expect(screen.getByText("API key required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add another Gmail account" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search integrations" }), { target: { value: "missing" } });
    expect(screen.getByText("No integrations found")).toBeTruthy();
  });
});
