// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeChatImportAdapter } from "@matrix-os/ui";
import ChatImportSection from "@desktop/renderer/src/features/settings/sections/ChatImportSection";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), adapter: null as NativeChatImportAdapter | null }));
vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: mocks.invoke, onEvent: vi.fn() }));
vi.mock("@matrix-os/ui", () => ({ ChatImportPanel: ({ native }: { native: NativeChatImportAdapter }) => {
  mocks.adapter = native;
  return null;
} }));
afterEach(() => { cleanup(); mocks.invoke.mockReset(); useConnection.setState(useConnection.getInitialState(), true); });

it("releases every late prepared preview before rejecting a stopped Settings request", async () => {
  useConnection.setState({ api: {} as never, runtimeSlot: "primary", authGeneration: 7 });
  let finish!: (response: unknown) => void;
  mocks.invoke.mockImplementation((channel: string) => channel === "runtime:chat-import-prepare"
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  render(<ChatImportSection />);
  const controller = new AbortController();
  const pending = mocks.adapter!.prepare!(["source_a", "source_b"], controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  finish({ status: "selected-many", selections: [{ selectionId: "preview_a" }, { selectionId: "preview_b" }], errors: [] });
  await rejected;
  expect(mocks.invoke).toHaveBeenCalledWith("runtime:chat-import-release", {
    runtimeSlot: "primary", authGeneration: 7, selectionIds: ["preview_a", "preview_b"],
  });
});

it("leaves a completed prepare response owned by its active caller", async () => {
  useConnection.setState({ api: {} as never });
  const response = { status: "selected-many", selections: [{ selectionId: "preview_a" }], errors: [] };
  mocks.invoke.mockResolvedValue(response);
  render(<ChatImportSection />);
  expect(await mocks.adapter!.prepare!(["source_a"], new AbortController().signal)).toBe(response);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
