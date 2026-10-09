// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EmbedHost from "@desktop/renderer/src/features/embeds/EmbedHost";
import { invoke, onEvent } from "@desktop/renderer/src/lib/operator";
vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: vi.fn(), onEvent: vi.fn() }));
let close!: (reply: { ok: boolean }) => void;
beforeEach(() => {
  vi.mocked(onEvent).mockImplementation(() => () => undefined);
  vi.mocked(invoke).mockImplementation((channel: string) => {
    if (channel === "embed:open") return Promise.resolve({ embedId: "failed-native-view", state: "failed" }) as any;
    if (channel === "embed:close") return new Promise(resolve => { close = resolve; }) as any;
    return Promise.resolve({ ok: true }) as any;
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("does not replace a failed native view until its guarded close has been confirmed", async () => {
  render(<EmbedHost kind="app" slug="utilities"/>);
  await screen.findByRole("button", { name: "Try again" });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(1);
  await act(async () => close({ ok: false }));
  expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await act(async () => close({ ok: true }));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(2));
});
