// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSection } from "../../shell/src/components/settings/sections/AgentSection.js";

vi.mock("../../shell/src/components/settings/sections/AgentRuntimePanel.js", () => ({
  AgentRuntimePanel: () => <div>Runtime settings</div>,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Canvas Agent section", () => {
  it("persists SOUL to its owner-controlled file", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/files/system/soul.md")
        ? new Response("Original soul")
        : Response.json({ displayName: "Matrix" })
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentSection />);

    expect(await screen.findByText("Original soul")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown editor" }), {
      target: { value: "Updated soul" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/files/system/soul.md"),
      expect.objectContaining({ method: "PUT", body: "Updated soul" }),
    ));
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/bridge/data"))).toBe(false);
  });
});
