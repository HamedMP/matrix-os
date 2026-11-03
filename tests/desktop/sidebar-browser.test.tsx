// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SidebarBrowser from "@desktop/renderer/src/features/browser/SidebarBrowser";
vi.mock("@desktop/renderer/src/features/embeds/EmbedHost", () => ({ default: ({ url, active }: { url: string; active: boolean }) => <div data-active={String(active)} data-testid="local-webview">{url}</div> }));
afterEach(cleanup);
it("opens public websites in the isolated local webview and suspends hidden views", () => {
  const { rerender } = render(<SidebarBrowser active />);
  fireEvent.change(screen.getByRole("textbox", { name: "Website address" }), { target: { value: "https://example.com/docs" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(screen.getByTestId("local-webview").textContent).toBe("https://example.com/docs");
  rerender(<SidebarBrowser active={false} />);
  expect(screen.getByTestId("local-webview").getAttribute("data-active")).toBe("false");
});
it("rejects script and local-file protocols", () => {
  render(<SidebarBrowser active />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "javascript:alert(1)" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(screen.getByRole("alert").textContent).toContain("Enter");
  expect(screen.queryByTestId("local-webview")).toBeNull();
});
