#!/usr/bin/env node
// A stand-in `herdr-core` binary: `herdr-core connect` speaks the framed
// protocol on stdio and holds two terminals. Plain JS so it runs without a loader.
if (process.argv[2] !== "connect") process.exit(2);
const pidFile = process.env.FAKE_HERDR_PID_FILE;
if (pidFile) (await import("node:fs")).writeFileSync(pidFile, String(process.pid));

const frame = (channel, kind, payload) => {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
};
const reply = (id, result) => process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }))));

let framed = false;
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!framed) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    buffer = buffer.subarray(newline + 1);
    framed = true;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      version: "0.1.19", generation: 1, framed: true, features: ["framed", "attach", "shell"],
      methods: ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"],
    } })}\n`);
  }
  while (buffer.length >= 9) {
    const length = buffer.readUInt32LE(5);
    if (buffer.length < 9 + length) break;
    const channel = buffer.readUInt32LE(0);
    const payload = buffer.subarray(9, 9 + length);
    buffer = buffer.subarray(9 + length);
    if (channel !== 0) continue;
    const call = JSON.parse(payload.toString("utf8"));
    if (call.method === "terminal.list") {
      reply(call.id, { terminals: [
        { address: "t1", state: "live", title: "claude", status: { state: "working" } },
        { address: "t2", state: "live", title: "shell", status: null },
      ] });
    } else {
      process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -1, message: "no", data: { kind: "unsupported" } } }))));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
