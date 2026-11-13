// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATRIX_MCP_ENDPOINT, matrixMcpEndpointUrl } from "../../packages/ui/src/integrations/matrix-mcp-endpoint.js";
import { MatrixMcpEndpointCard } from "../../packages/ui/src/integrations/MatrixMcpEndpointCard.js";
import { McpServiceLogo } from "../../packages/ui/src/integrations/McpServiceLogo.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("matrixMcpEndpointUrl", () => {
  // Fault: a local dev, VPS, or look-alike origin ends up in the URL users paste into their MCP clients.
  it("uses the platform origin only for https Matrix hosts", () => {
    expect(matrixMcpEndpointUrl("https://app.matrix-os.com")).toBe("https://app.matrix-os.com/mcp");
    expect(matrixMcpEndpointUrl("https://preview-12.matrix-os.com/vm/alice")).toBe("https://preview-12.matrix-os.com/mcp");
    expect(matrixMcpEndpointUrl("http://app.matrix-os.com")).toBe(DEFAULT_MATRIX_MCP_ENDPOINT);
    expect(matrixMcpEndpointUrl("https://matrix-os.com.evil.example")).toBe(DEFAULT_MATRIX_MCP_ENDPOINT);
    expect(matrixMcpEndpointUrl("http://localhost:3000")).toBe(DEFAULT_MATRIX_MCP_ENDPOINT);
    expect(matrixMcpEndpointUrl("not a url")).toBe(DEFAULT_MATRIX_MCP_ENDPOINT);
    expect(matrixMcpEndpointUrl(null)).toBe(DEFAULT_MATRIX_MCP_ENDPOINT);
  });
});

describe("MatrixMcpEndpointCard", () => {
  it("copies the endpoint and shows setup for the chosen client", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<MatrixMcpEndpointCard endpointUrl="https://app.matrix-os.com/mcp" connectedServices={[{ presetId: "linear", name: "Linear" }]} />);

    expect(screen.getByText("Routes to 1 service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy Matrix MCP URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.matrix-os.com/mcp"));

    expect(screen.getByRole("tabpanel").textContent).toContain("claude mcp add --transport http matrix https://app.matrix-os.com/mcp");
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("codex mcp add matrix --url https://app.matrix-os.com/mcp");
  });

  // Fault: a denied clipboard (sandboxed or unfocused window) throws out of the click handler.
  it("reports a failed copy instead of throwing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<MatrixMcpEndpointCard endpointUrl="https://app.matrix-os.com/mcp" connectedServices={[]} />);
    expect(screen.getByText("No services yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy Matrix MCP URL" }));
    expect(await screen.findByText("Copy failed")).toBeTruthy();
    warn.mockRestore();
  });
});

describe("McpServiceLogo", () => {
  it("draws the catalog brand mark and falls back to a monogram for custom servers", () => {
    const { container, rerender } = render(<McpServiceLogo presetId="linear" name="Linear" />);
    expect(container.querySelector("[data-mcp-logo='linear'] path")).toBeTruthy();
    rerender(<McpServiceLogo presetId="__proto__" name="research tools" />);
    expect(container.querySelector("[data-mcp-logo='fallback']")?.textContent).toBe("R");
  });
});
