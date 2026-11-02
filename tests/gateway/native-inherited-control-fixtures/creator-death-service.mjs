// Fixed fixture channel3 is public net.Socket ownership, not Node private IPC.
// Only native owns application stdio0/1; records are observations, not authority.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Socket } from "node:net";
const native = createRequire(import.meta.url)(process.argv[2]);
const channel = new Socket({ fd: 3, readable: true, writable: true });
let handle, buffered = "", commands = 0, busy = false;
async function tell(tag, value) {
  const bytes = `${tag} ${JSON.stringify(value)}\n`; assert.ok(Buffer.byteLength(bytes) <= 4096);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture channel deadline")), 2000);
    channel.write(bytes, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}
function finish(code) { try { if (handle) native.close(handle); } finally { process.exit(code); } }
channel.on("error", () => finish(1));
channel.on("end", () => finish(1));
channel.on("data", async chunk => {
  try {
    buffered += chunk; assert.ok(Buffer.byteLength(buffered) <= 128);
    const newline = buffered.indexOf("\n"); if (newline < 0) return;
    assert.ok(!busy && ++commands <= 3 && newline === buffered.length - 1); busy = true;
    const command = buffered.slice(0, newline); buffered = "";
    if (command === "CHECK") {
      const current = native.inheritedControlCurrent(handle); // FIRST native operation since ready.
      const result = { event: "creator-check", current, debugProbeAttempted: false, queuedNativeBytesFetched: null,
        receiveClosedError: false, sendClosedError: false, readoptionRefused: false };
      if (current === true) {
        result.debugProbeAttempted = true;
        try { const frame = native.receive(handle); result.queuedNativeBytesFetched = frame?.data?.length ?? 0; }
        catch (error) { result.queuedNativeBytesFetched = 0; }
      } else if (current === false) {
        try { native.receive(handle); } catch (error) { result.receiveClosedError = true; }
        try { native.send(handle, Buffer.from("must-not-send")); } catch (error) { result.sendClosedError = true; }
        try { native.inheritedControl(); } catch (error) { result.readoptionRefused = true; }
      }
      await tell("C", result); // Never parse/dispatch fixed queued fixture bytes.
    } else if (command === "PING") await tell("P", { event: "service-pong" });
    else if (command === "EXIT") finish(0);
    else throw new Error("unknown fixed fixture command");
    busy = false;
  } catch (error) { await tell("F", { event: "fixture-error", errorType: error.name }).finally(() => finish(1)); }
});
try {
  handle = native.inheritedControl(); assert.equal(native.inheritedControlCurrent(handle), true);
  const ready = Buffer.from("native-ready"); assert.equal(native.send(handle, ready), ready.length);
  await tell("R", { event: "service-ready", current: true });
} catch (error) { await tell("F", { event: "fixture-error", errorType: error.name }).finally(() => finish(1)); }
