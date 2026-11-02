// Actual separate same-UID writer. The PID argument is ONLY deliberately forged
// body content; expected kernel identity comes from the parent's spawn return.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
const claimedPID = Number(process.argv[2]);
assert.ok(Number.isInteger(claimedPID) && claimedPID > 1 && claimedPID !== process.pid);
let busy = false, commands = 0;
async function tell(value) {
  assert.ok(process.connected && Buffer.byteLength(JSON.stringify(value)) <= 1024);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer fixture IPC deadline")), 2000);
    process.send(value, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}
process.on("message", async message => {
  try {
    assert.ok(!busy && ++commands <= 4 && message && Object.keys(message).length === 1);
    busy = true;
    if (message.command === "emit") {
      const body = Buffer.from(JSON.stringify({ pid: claimedPID, verified: true }));
      assert.ok(body.length <= 256);
      assert.equal(writeSync(0, body), body.length); // Fixed inherited opposite endpoint only.
      await tell({ event: "writer-emitted", bytes: body.length, hex: body.toString("hex") });
    } else if (message.command === "ping") await tell({ event: "writer-pong" });
    else if (message.command === "exit") process.exit(0);
    else throw new Error("unknown writer fixture command");
    busy = false;
  } catch (error) {
    await tell({ event: "writer-error", errorType: error.name }).catch(() => { writeSync(2, "writer fixture IPC unavailable\n"); });
    process.exit(1);
  }
});
await tell({ event: "writer-ready" });
