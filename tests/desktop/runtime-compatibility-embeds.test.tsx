// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EmbedHost from "@renderer/features/embeds/EmbedHost";
import RuntimeCompatibilityGate from "@renderer/features/updates/RuntimeCompatibilityGate";
import { RUNTIME_RECONNECTED_EVENT } from "@renderer/lib/runtime-compatibility";
import { useConnection } from "@renderer/stores/connection";
import { useUi } from "@renderer/stores/ui";
import type { ApiClient } from "@renderer/lib/api";

const source = { commit: "b".repeat(40), ancestors: ["a".repeat(40)] };
const compatible = { version: "v1", build: { sha: source.commit } };
const incompatible = { version: "v2", build: { sha: "a".repeat(40) } };
beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("restores only the active embed after modal dismissal (nested overlay: %s)", async (nested) => {
  const live: Record<string, boolean> = {};
  const get = vi.fn().mockResolvedValue(compatible);
  const api = { get, forRuntime() { return this; } } as unknown as ApiClient;
  useConnection.setState({ api });
  const invoke = vi.fn(async (channel: string, payload: { embedId?: string; active?: boolean; kind?: string }) => {
    if (channel === "app:get-version") return { version: "0.1.0", source };
    if (channel === "embed:open") { live[payload.kind!] = Boolean(payload.active); return { embedId: payload.kind, state: "ready" }; }
    if (channel === "embed:set-active") live[payload.embedId!] = Boolean(payload.active);
    if (channel === "embed:deactivate") live[payload.embedId!] = false;
    if (channel === "embed:suspend-all") Object.keys(live).forEach((id) => { live[id] = false; });
    return { ok: true };
  });
  vi.stubGlobal("operator", { invoke, on: () => () => {} });
  render(<RuntimeCompatibilityGate><EmbedHost kind="hosted-shell" active /><EmbedHost kind="code-editor" active={false} /></RuntimeCompatibilityGate>);
  await waitFor(() => expect(live).toEqual({ "hosted-shell": true, "code-editor": false }));
  get.mockResolvedValue(incompatible);
  act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
  await screen.findByRole("dialog", { name: "Update Matrix OS" });
  expect(live).toEqual({ "hosted-shell": false, "code-editor": false });
  if (nested) act(() => useUi.getState().acquireRendererOverlay());
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  if (nested) {
    await act(async () => {});
    expect(live).toEqual({ "hosted-shell": false, "code-editor": false });
    act(() => useUi.getState().releaseRendererOverlay());
  }
  await waitFor(() => expect(live).toEqual({ "hosted-shell": true, "code-editor": false }));
  expect(invoke.mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(2);
});

it("keeps a pending embed detached until the compatibility modal closes", async () => {
  let finishOpen!: (value: { embedId: string; state: string }) => void;
  let live = false;
  const get = vi.fn().mockResolvedValue(compatible);
  useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
  const invoke = vi.fn(async (channel: string, payload: { active?: boolean }) => {
    if (channel === "app:get-version") return { version: "0.1.0", source };
    if (channel === "embed:open") return new Promise((resolve) => { finishOpen = resolve; });
    if (channel === "embed:set-active") live = Boolean(payload.active);
    if (channel === "embed:deactivate" || channel === "embed:suspend-all") live = false;
    return { ok: true };
  });
  vi.stubGlobal("operator", { invoke, on: () => () => {} });
  render(<RuntimeCompatibilityGate><EmbedHost kind="hosted-shell" active /></RuntimeCompatibilityGate>);
  await act(async () => {});
  get.mockResolvedValue(incompatible);
  act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
  await screen.findByRole("dialog", { name: "Update Matrix OS" });
  await act(async () => finishOpen({ embedId: "pending", state: "ready" }));
  expect(live).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  await waitFor(() => expect(live).toBe(true));
});
