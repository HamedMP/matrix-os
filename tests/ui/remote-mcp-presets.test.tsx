// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpConnectionInventory,
  customMcpErrorMessage,
  filterRemoteMcpPresets,
  parseRemoteMcpCatalog,
} from "../../packages/ui/src/integrations/remote-mcp-presets.js";
import { RemoteMcpPresetPicker } from "../../packages/ui/src/integrations/RemoteMcpPresetPicker.js";
import { McpConnectionInventory } from "../../packages/ui/src/integrations/McpConnectionInventory.js";

const linear = { id: "linear", name: "Linear", description: "Manage issues", category: "project_management", departments: ["engineering", "product"], url: "https://mcp.linear.app/mcp", auth: "oauth_dcr", demandRank: 9 };
const lemlist = { id: "lemlist", name: "lemlist", description: "Outreach campaigns", category: "sales", departments: ["sales", "marketing"], url: "https://app.lemlist.com/mcp", auth: "oauth_dcr" };
const presets = parseRemoteMcpCatalog({ presets: [linear, lemlist] });

afterEach(cleanup);

describe("remote MCP preset derivations", () => {
  // Fault: a malformed or hostile catalog payload renders arbitrary links or crashes Settings.
  it("accepts only well-formed HTTPS presets", () => {
    expect(presets.map(preset => preset.id)).toEqual(["linear", "lemlist"]);
    expect(parseRemoteMcpCatalog({ presets: [{ ...linear, url: "javascript:alert(1)" }, { ...linear, id: "x".repeat(200) }, null] })).toEqual([]);
    expect(() => parseRemoteMcpCatalog({ nope: true })).toThrow();
    expect(() => parseRemoteMcpCatalog({ presets: Array.from({ length: 300 }, () => linear) })).toThrow();
  });

  it("searches names, descriptions and categories and filters by department", () => {
    expect(filterRemoteMcpPresets(presets, { query: "  ISSUES " }).map(preset => preset.id)).toEqual(["linear"]);
    expect(filterRemoteMcpPresets(presets, { query: "sales" }).map(preset => preset.id)).toEqual(["lemlist"]);
    expect(filterRemoteMcpPresets(presets, { department: "marketing" }).map(preset => preset.id)).toEqual(["lemlist"]);
    expect(filterRemoteMcpPresets(presets, {})).toHaveLength(2);
  });

  // Fault: provider names, paths, or database text from a server error reach the UI.
  it("maps server errors to allowlisted copy only", () => {
    expect(customMcpErrorMessage(409, { code: "oauth_client_setup_required", error: "secret upstream detail" }))
      .toBe("This service needs administrator setup before you can sign in.");
    expect(customMcpErrorMessage(409, { error: "Revision conflict" })).toBe("This connection changed elsewhere. Refresh and try again.");
    expect(customMcpErrorMessage(429, {})).toBe("Too many requests. Wait a moment and try again.");
    expect(customMcpErrorMessage(502, { error: "connect ECONNREFUSED 10.0.0.4 /var/lib/postgres" })).toBe("The MCP request failed. Try again.");
  });

  it("lists MCP servers and read-only Pipedream services in one inventory", () => {
    const inventory = buildMcpConnectionInventory(
      [{ id: "s1", name: "Linear", url: "https://mcp.linear.app/mcp", status: "ready" }],
      [{ id: "p1", service: "gmail", account_label: "Work", status: "active" }],
      { gmail: "Gmail" },
    );
    expect(inventory).toEqual([
      { kind: "mcp", id: "s1", name: "Linear", statusLabel: "Connected", presetId: "linear" },
      { kind: "pipedream", id: "p1", name: "Gmail", statusLabel: "Connected", accountLabel: "Work" },
    ]);
  });
});

describe("RemoteMcpPresetPicker", () => {
  it("connects an unconnected preset and marks connected ones", () => {
    const onConnect = vi.fn();
    render(<RemoteMcpPresetPicker presets={presets} state="ready" connectedUrls={["https://app.lemlist.com/mcp"]} connectingId={null} onConnect={onConnect} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    expect(onConnect).toHaveBeenCalledWith("linear");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect lemlist" })).toBeNull();
  });

  it("filters by search and department and explains an empty result", () => {
    render(<RemoteMcpPresetPicker presets={presets} state="ready" connectedUrls={[]} connectingId={null} onConnect={vi.fn()} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(screen.queryByText("Linear")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search MCP services" }), { target: { value: "zzz" } });
    expect(screen.getByText("No services match")).toBeTruthy();
  });

  it("shows loading and a retryable error", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RemoteMcpPresetPicker presets={[]} state="loading" connectedUrls={[]} connectingId={null} onConnect={vi.fn()} onRetry={onRetry} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    rerender(<RemoteMcpPresetPicker presets={[]} state="error" connectedUrls={[]} connectingId={null} onConnect={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading MCP services" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("McpConnectionInventory", () => {
  it("renders an onboarding empty state and labels Pipedream rows as managed elsewhere", () => {
    const { rerender } = render(<McpConnectionInventory entries={[]} />);
    expect(screen.getByText("No connections yet")).toBeTruthy();
    rerender(<McpConnectionInventory entries={[{ kind: "pipedream", id: "p1", name: "Gmail", statusLabel: "Connected", accountLabel: "Work" }]} />);
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText(/Connected app · Work/)).toBeTruthy();
  });
});
