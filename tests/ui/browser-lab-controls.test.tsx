// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://app.matrix-os.com/vm/pr-2526" }));
vi.mock("../../shell/src/lib/app-session", () => ({ openAppSession: vi.fn(async () => {}) }));
import { BrowserLabView } from "../../shell/src/components/BrowserLabView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not offer diagnostic actions when shared Chat owns Chrome", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/api/status")) return Response.json({ phase: "idle", engine: null, generation: 0,
      checkpoint: 0, workCompleted: 0, humanControlAvailable: true },
    { headers: { "x-matrix-browser-lab-comparison": "disabled" } });
    if (url.endsWith("/api/viewer-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    throw new Error("Unexpected Browser Lab request");
  });
  vi.stubGlobal("fetch", fetcher);
  render(<BrowserLabView />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Run comparison" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Take over" }).hasAttribute("disabled")).toBe(true);
  expect((screen.getByTitle("Live VPS Chrome including password manager windows") as HTMLIFrameElement).hasAttribute("inert")).toBe(true);
  expect(screen.getByText(/shared Chat owns Chrome/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/control"))).toBe(false);
});

it("offers comparison actions when the gateway advertises diagnostic mode", async () => {
  const idle = { phase: "idle", engine: null, generation: 0, checkpoint: 0, workCompleted: 0, humanControlAvailable: true };
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/api/status")) return Response.json(idle, { headers: { "x-matrix-browser-lab-comparison": "enabled" } });
    if (url.endsWith("/api/viewer-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    if (url.endsWith("/api/control")) return Response.json({ ...idle, phase: "running", engine: "agent-browser", generation: 1, humanControlAvailable: false });
    throw new Error("Unexpected Browser Lab request");
  });
  vi.stubGlobal("fetch", fetcher);
  render(<BrowserLabView />);
  const button = screen.getByRole("button", { name: "Run comparison" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/control"))).toBe(true));
});
