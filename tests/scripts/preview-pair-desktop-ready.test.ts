import { connect } from "node:net";
import { expect, it } from "vitest";
import { previewDesktopReady } from "../../scripts/preview-pair/desktop-ready.js";
import { acknowledgePreviewDesktop } from "../../desktop/src/main/preview-pair-ready.js";
import { verifiedPreviewPairTestContext } from "../desktop/preview-pair-test-context.js";
it("roundtrips the real main-process acknowledgement through a bounded loopback listener", async () => {
  const context = await verifiedPreviewPairTestContext(), server = await previewDesktopReady(context);
  try { await acknowledgePreviewDesktop(context, server.port); expect(await server.ready).toBe(process.pid); }
  finally { await server.dispose(); }
});
it("ignores another role and bounds an unresponsive candidate startup", async () => {
  const context = await verifiedPreviewPairTestContext(), server = await previewDesktopReady(context, 80);
  try {
    await acknowledgePreviewDesktop({ ...context, role: "member" }, server.port);
    await expect(server.ready).rejects.toThrow("timed out");
  } finally { await server.dispose(); }
});
it("destroys an oversized local message and still closes every accepted socket", async () => {
  const context = await verifiedPreviewPairTestContext(), server = await previewDesktopReady(context, 80);
  try {
    const socket = connect({ host: "127.0.0.1", port: Number(server.port) });
    await new Promise<void>(resolve => socket.once("connect", () => { socket.end("x".repeat(3000)); resolve(); }));
    await expect(server.ready).rejects.toThrow("timed out");
  } finally { await server.dispose(); }
});
