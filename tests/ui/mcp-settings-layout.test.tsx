// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpConnectionInventory } from "../../packages/ui/src/integrations/remote-mcp-presets.js";
import { McpConnectionInventory } from "../../packages/ui/src/integrations/McpConnectionInventory.js";
import { McpAddServicesSection } from "../../packages/ui/src/integrations/McpAddServicesSection.js";

afterEach(cleanup);

const tools = [{ name: "search" }, { name: "summarize" }, { name: "fetch" }];
const inventory = buildMcpConnectionInventory(
  [{ id: "s1", name: "Linear", url: "https://mcp.linear.app/mcp", status: "ready", tools }],
  [{ id: "p1", service: "gmail", status: "active" }],
  { gmail: "Gmail" },
);

function renderInventory() {
  return render(<McpConnectionInventory entries={inventory}
    renderDetails={(entry) => <p>Tool policy for {entry.name}</p>} />);
}

describe("McpConnectionInventory compact rows", () => {
  // Fault: every connected MCP dumps its full tool list inline, burying the connections list.
  it("collapses each server's tools by default and shows the tool count", () => {
    renderInventory();
    const toggle = screen.getByRole("button", { name: "3 tools for Linear" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Tool policy for Linear")).toBeNull();
  });

  // Fault: tools cannot be reached once collapsed, so per-tool policy becomes uneditable.
  it("expands and collapses the tools with the row toggle", () => {
    renderInventory();
    const toggle = screen.getByRole("button", { name: "3 tools for Linear" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Tool policy for Linear")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Tool policy for Linear")).toBeNull();
  });

  // Fault: read-only connected apps get a dead tools toggle with nothing behind it.
  it("does not offer a tools toggle for connected apps", () => {
    renderInventory();
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /for Gmail/ })).toBeNull();
  });

  it("uses the singular for a single tool", () => {
    const single = buildMcpConnectionInventory([{ id: "s1", name: "Docs", url: "https://example.com/mcp", status: "ready", tools: [{ name: "read" }] }], []);
    render(<McpConnectionInventory entries={single} renderDetails={() => <p>details</p>} />);
    expect(screen.getByRole("button", { name: "1 tool for Docs" })).toBeTruthy();
  });
});

describe("McpAddServicesSection", () => {
  // Fault: once something is connected, the gallery stays expanded and crowds the settings page, or cannot be reopened.
  it("keeps the gallery behind an Add MCP button when connections exist", () => {
    render(<McpAddServicesSection hasConnections><p>Gallery</p></McpAddServicesSection>);
    const button = screen.getByRole("button", { name: "Add MCP" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Gallery")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Gallery")).toBeTruthy();
  });

  // Fault: a new user with nothing connected has to discover a hidden button before they can add anything.
  it("opens the gallery by default when nothing is connected", () => {
    render(<McpAddServicesSection hasConnections={false}><p>Gallery</p></McpAddServicesSection>);
    expect(screen.getByRole("button", { name: "Add MCP" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Gallery")).toBeTruthy();
  });
});

describe("McpAddServicesSection initial state", () => {
  // Fault: the add form disappears when the list fails to load, or the gallery snaps shut the moment a preset connects mid sign-in.
  it("stays visible until the first known value and then keeps the user's state", () => {
    const { rerender } = render(<McpAddServicesSection hasConnections={undefined}><p>Gallery</p></McpAddServicesSection>);
    expect(screen.getByText("Gallery")).toBeTruthy();
    rerender(<McpAddServicesSection hasConnections={false}><p>Gallery</p></McpAddServicesSection>);
    expect(screen.getByText("Gallery")).toBeTruthy();
    rerender(<McpAddServicesSection hasConnections><p>Gallery</p></McpAddServicesSection>);
    expect(screen.getByText("Gallery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    expect(screen.queryByText("Gallery")).toBeNull();
  });

  it("collapses once loading reveals existing connections", () => {
    const { rerender } = render(<McpAddServicesSection hasConnections={undefined}><p>Gallery</p></McpAddServicesSection>);
    rerender(<McpAddServicesSection hasConnections><p>Gallery</p></McpAddServicesSection>);
    expect(screen.queryByText("Gallery")).toBeNull();
  });
});
