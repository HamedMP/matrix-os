import { createServer, type Socket } from "node:net";
import { PreviewPairReadySchema, previewReadyMessage } from "../../desktop/src/main/preview-pair-ready.js";
import type { PreviewPairLaunchContext } from "../../packages/contracts/src/preview-pair-launch.js";
export async function previewDesktopReady(context: PreviewPairLaunchContext, timeoutMs = 30_000) {
  const expected = previewReadyMessage(context), sockets = new Set<Socket>(); // <=4, drained on shutdown/timeouts.
  let settle: ((value: number) => void) | undefined, fail: ((reason: Error) => void) | undefined, connections = 0;
  const ready = new Promise<number>((resolve, reject) => { settle = resolve; fail = reject; });
  // A caller may still be spawning while an early socket/server error occurs.
  void ready.catch((error: unknown) => { console.warn("[preview-pair] local startup unavailable", error instanceof Error ? error.name : "UnknownError"); });
  const server = createServer(socket => {
    if (++connections > 4) { socket.destroy(); fail?.(new Error("Preview startup is unavailable")); return; }
    sockets.add(socket); socket.setTimeout(5_000); let text = "";
    socket.on("timeout", () => socket.destroy()); socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", bytes => {
      text += bytes.toString("utf8");
      if (Buffer.byteLength(text) > 2048) { socket.destroy(); return; }
      if (!text.endsWith("\n")) return;
      try {
        const message = PreviewPairReadySchema.parse(JSON.parse(text));
        for (const key of Object.keys(expected) as Array<keyof typeof expected>) if (key !== "pid" && message[key] !== expected[key]) throw new Error("Wrong preview startup");
        settle?.(message.pid); socket.end();
      } catch (error: unknown) { console.warn("[preview-pair] startup acknowledgement rejected", error instanceof Error ? error.name : "UnknownError"); socket.destroy(); }
    });
  });
  server.maxConnections = 4;
  server.on("error", () => fail?.(new Error("Preview startup is unavailable")));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Preview launcher is unavailable");
  const timer = setTimeout(() => fail?.(new Error("Preview startup timed out")), timeoutMs);
  return { port: String(address.port), ready, async dispose() {
    clearTimeout(timer); for (const socket of sockets) socket.destroy(); sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
