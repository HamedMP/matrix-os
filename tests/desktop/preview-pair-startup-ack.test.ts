import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { createPreviewStartupAcknowledgement } from "@desktop/main/preview-pair-startup-ack";
import { verifiedPreviewPairTestContext } from "./preview-pair-test-context.js";

const transport = vi.hoisted(() => ({ acknowledge: vi.fn() }));
vi.mock("@desktop/main/preview-pair-ready", () => ({ acknowledgePreviewDesktop: transport.acknowledge }));
beforeEach(() => { transport.acknowledge.mockReset(); });

it("keeps a preview app alive when the Dock recreates its window after startup", async () => {
  // The launcher closes its one-use listener after the first acknowledgement.
  // Keep actual window-event wiring; only the external TCP response is selected.
  transport.acknowledge.mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("Original launcher listener is closed"));
  const quit = vi.fn(), bind = createPreviewStartupAcknowledgement(await verifiedPreviewPairTestContext(), "1234", quit);
  const first = new EventEmitter(); bind(first); first.emit("did-finish-load");
  await Promise.resolve();
  expect(transport.acknowledge).toHaveBeenCalledTimes(1);
  const dockWindow = new EventEmitter(); bind(dockWindow); dockWindow.emit("did-finish-load");
  await Promise.resolve(); await Promise.resolve();
  expect(quit).not.toHaveBeenCalled();
  expect(transport.acknowledge).toHaveBeenCalledTimes(1);
});

it("retains fail-closed handling when the initial launcher acknowledgement fails", async () => {
  const failure = new Error("Launcher unavailable"); transport.acknowledge.mockRejectedValue(failure);
  const quit = vi.fn(), bind = createPreviewStartupAcknowledgement(await verifiedPreviewPairTestContext(), "1234", quit);
  const first = new EventEmitter(); bind(first); first.emit("did-finish-load");
  await Promise.resolve(); await Promise.resolve();
  expect(quit).toHaveBeenCalledWith(failure);
});
