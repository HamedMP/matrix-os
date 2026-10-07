// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("filters OAuth and connected apps without duplicate category rows", () => {
    expect(buildIntegrationSections(services, { oauthOnly: true }).flatMap(s => s.services).map(s => s.id)).not.toContain("stripe");
    expect(buildIntegrationSections(services, { connectedOnly: true, connectedIds: ["gmail"] }).flatMap(s => s.services).map(s => s.id)).toEqual(["gmail"]);
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
