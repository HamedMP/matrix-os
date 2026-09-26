import { expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { awaitMirrorOperation } from "../../../packages/gateway/src/sync/home-mirror-abort.js";
it("observes an already-started operation's late rejection when aborted before awaiting", async () => {
  const controller = new AbortController(); controller.abort(new Error("synthetic deadline"));
  let reject!: (reason: Error) => void;
  const started = new Promise<void>((_resolve, failure) => { reject = failure; });
  await expect(awaitMirrorOperation(started, controller.signal)).rejects.toBe(controller.signal.reason);
  reject(new Error("synthetic late I/O failure"));
  await setImmediate(); await setImmediate();
});
