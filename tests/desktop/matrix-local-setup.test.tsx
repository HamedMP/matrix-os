// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MatrixLocalSetup } from "../../packages/ui/src/matrix-local-setup/MatrixLocalSetup";

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("distinguishes local setup, remote execution, and unverified availability", () => {
  render(<MatrixLocalSetup />);
  expect(screen.getByRole("heading", { name: "Matrix CLI & MCP" })).toBeTruthy();
  for (const name of ["CLI", "MCP", "Skills & plugins"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
  expect(screen.getByText(/your local computer, not in your Matrix VPS/)).toBeTruthy();
  expect(screen.getByText(/Availability is not checked here/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /enable|run installer/i })).toBeNull();
  expect(writeText).not.toHaveBeenCalled();
});

it.each([
  ["Copy MCP URL", "https://api.matrix-os.com/mcp"],
  ["Copy Codex MCP", "codex mcp add matrix --url https://api.matrix-os.com/mcp\ncodex mcp login matrix"],
  ["Copy Claude Code MCP", "claude mcp add --transport http --scope user matrix https://api.matrix-os.com/mcp"],
  ["Copy Codex plugin", "codex plugin marketplace add HamedMP/matrix-os"],
  ["Copy Claude Code plugin", "/plugin marketplace add HamedMP/matrix-os\n/plugin install matrix-os@matrix-os"],
])("%s only copies setup text", async (label, command) => {
  render(<MatrixLocalSetup />);
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  expect(screen.getByRole("status").textContent).toContain("Copied");
});

it("offers HTTPS setup links without bypassing desktop protocol protections", () => {
  render(<MatrixLocalSetup />);
  for (const name of ["Set up Cursor", "Set up VS Code", "MCP documentation"]) {
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toMatch(/^https:\/\/matrix-os\.com\/docs\/mcp/);
    expect(link.getAttribute("rel")).toContain("noopener");
  }
});

it("clears stale success and safely handles clipboard failure and retry", async () => {
  render(<MatrixLocalSetup />);
  const button = screen.getByRole("button", { name: "Copy MCP URL" });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Copied"));
  writeText.mockRejectedValueOnce(new Error("private-token"));
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not copy. Select and copy the text manually."));
  expect(screen.queryByText("private-token")).toBeNull();
  expect(screen.queryByText("Copied")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
