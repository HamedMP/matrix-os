// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DevRunBanner } from "@desktop/renderer/src/features/preview/DevRunBanner";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: mocks.invoke }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows the dev label, branch, sha, and platform origin so testers know which PR build this is", async () => {
  mocks.invoke.mockResolvedValue({ label: "PR #3314 · Core MCP approvals", sha: "abc123def456", branch: "feat/core-mcp",
    platformOrigin: "https://pr-3314-preview.matrix-os.com", apiOrigin: "https://api.example.test" });
  render(<DevRunBanner />);
  const text = (await screen.findByRole("status")).textContent;
  expect(text).toContain("Dev build · PR #3314 · Core MCP approvals");
  expect(text).toContain("feat/core-mcp @ abc123def456");
  expect(text).toContain("https://pr-3314-preview.matrix-os.com");
  expect(text).toContain("API https://api.example.test");
  expect(mocks.invoke).toHaveBeenCalledWith("app:get-dev-run", {});
});
it("renders nothing when no dev label is configured", async () => {
  mocks.invoke.mockResolvedValue(null); render(<DevRunBanner />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  expect(screen.queryByRole("status")).toBeNull();
});
it("omits git details that could not be read", async () => {
  mocks.invoke.mockResolvedValue({ label: "local", sha: null, branch: null, platformOrigin: null, apiOrigin: null });
  render(<DevRunBanner />);
  expect((await screen.findByRole("status")).textContent).toBe("Dev build · local");
});
