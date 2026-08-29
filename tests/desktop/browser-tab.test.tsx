// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserTab from "@desktop/renderer/src/features/browser/BrowserTab";
import { invoke } from "@desktop/renderer/src/lib/operator";

vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: vi.fn() }));
vi.mock("@desktop/renderer/src/features/embeds/EmbedHost", () => ({
  default: ({ kind, url }: { kind: string; url: string }) => <div data-testid="embed">{kind}:{url}</div>,
}));

describe("BrowserTab", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("keeps loopback navigation inside the selected runtime embed", () => {
    render(<BrowserTab active />);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "127.0.0.1:3000/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByTestId("embed").textContent).toBe("browser:http://127.0.0.1:3000/docs");
    expect(invoke).not.toHaveBeenCalledWith("shell:open-external", expect.anything());
  });

  it("opens public URLs and searches in the local browser", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true });
    render(<BrowserTab active />);

    const address = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(address, { target: { value: "127.0.0.1:3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByTestId("embed")).toBeTruthy();

    fireEvent.change(address, { target: { value: "Matrix OS docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://www.google.com/search?q=Matrix+OS+docs",
    }));
    expect(screen.queryByTestId("embed")).toBeNull();
  });
});
