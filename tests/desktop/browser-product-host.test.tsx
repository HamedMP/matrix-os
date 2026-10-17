// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EmbedHost from "@desktop/renderer/src/features/embeds/EmbedHost";
import { invoke } from "@desktop/renderer/src/lib/operator";
import { useConnection } from "@desktop/renderer/src/stores/connection";
vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: vi.fn(), onEvent: vi.fn(() => () => {}) }));
beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("recreates only the product view after same-runtime native reauthentication", async () => {
  let count = 0;
  vi.mocked(invoke).mockImplementation(async channel => channel === "embed:open" ? { embedId: `view-${++count}`, state: "ready" } : { ok: true });
  render(<EmbedHost kind="app" slug="browser-lab" appIdentity="matrix-browser" />);
  await waitFor(() => expect(count).toBe(1));
  await act(async () => { useConnection.setState({ authGeneration: 2 }); });
  await waitFor(() => expect(count).toBe(2));
  expect(invoke).toHaveBeenCalledWith("embed:close", { embedId: "view-1" });
});
it("shows a clear installed-service unavailable state instead of opening an external browser", async () => {
  vi.mocked(invoke).mockImplementation(async channel => channel === "embed:open" ? { embedId: "failed", state: "failed" } : { ok: true });
  render(<EmbedHost kind="app" slug="browser-lab" appIdentity="matrix-browser" />);
  expect(await screen.findByText("Browser is unavailable on this computer.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === "shell:open-external")).toBe(false);
});
it("keeps the generic public-browser embed lifecycle unchanged on product admission refresh", async () => {
  let count = 0;
  vi.mocked(invoke).mockImplementation(async channel => channel === "embed:open" ? { embedId: `generic-${++count}`, state: "ready" } : { ok: true });
  render(<EmbedHost kind="browser" url="https://example.com/" />);
  await waitFor(() => expect(count).toBe(1));
  await act(async () => { useConnection.setState({ authGeneration: 2 }); });
  expect(count).toBe(1);
});
