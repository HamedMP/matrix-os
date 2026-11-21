import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGuestAgent,
  GUEST_AGENT_PORT,
  MAX_LINE_BYTES,
  parseMemoryStats,
  serveConnection,
  type GuestAgent,
} from "../../packages/hostd/src/guest-agent/agent.js";
import { createGuestClient, GuestError } from "../../packages/hostd/src/guest-client.js";

const PRESSURE = [
  "some avg10=12.50 avg60=3.10 avg300=0.80 total=123456",
  "full avg10=4.00 avg60=1.00 avg300=0.20 total=6543",
  "",
].join("\n");

const MEMINFO = [
  "MemTotal:        4030464 kB",
  "MemFree:          204800 kB",
  "MemAvailable:     409600 kB",
  "Buffers:           10240 kB",
  "Cached:           512000 kB",
  "Active(anon):    1048576 kB",
  "Inactive(anon):   524288 kB",
  "Active(file):     262144 kB",
  "",
].join("\n");

function fixtureAgent(trims: { count: number }): GuestAgent {
  return createGuestAgent({
    async readProc(path) {
      if (path === "/proc/pressure/memory") return PRESSURE;
      if (path === "/proc/meminfo") return MEMINFO;
      throw new Error(`unexpected read ${path}`);
    },
    async trim() {
      trims.count += 1;
    },
  });
}

interface Conversation {
  input: PassThrough;
  lines: string[];
  ended: Promise<void>;
}

function converse(agent: GuestAgent, idleMs?: number): Conversation {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  const ended = serveConnection(agent, input, output, idleMs === undefined ? {} : { idleMs });
  return { input, lines, ended };
}

describe("guest agent", () => {
  it("guest agent answers stats from /proc/pressure/memory and /proc/meminfo fixtures", async () => {
    const trims = { count: 0 };
    const convo = converse(fixtureAgent(trims));
    convo.input.write('{"op":"stats"}\n');
    convo.input.end();
    await convo.ended;
    expect(convo.lines.map((l) => JSON.parse(l))).toEqual([
      { psiSome10: 12.5, availableMiB: 400, anonMiB: 1536 },
    ]);
    expect(trims.count).toBe(0);
  });

  it("guest agent rejects a line longer than 4 KiB", async () => {
    const convo = converse(fixtureAgent({ count: 0 }));
    convo.input.write("x".repeat(MAX_LINE_BYTES + 1));
    await convo.ended;
    expect(convo.lines.map((l) => JSON.parse(l))).toEqual([{ error: "bad_request" }]);
  });

  it("answers trim with ok after running the trim", async () => {
    const trims = { count: 0 };
    const convo = converse(fixtureAgent(trims));
    convo.input.write('{"op":"trim"}\n');
    convo.input.end();
    await convo.ended;
    expect(convo.lines.map((l) => JSON.parse(l))).toEqual([{ ok: true }]);
    expect(trims.count).toBe(1);
  });

  it("answers bad_request to unknown ops, invalid JSON, and non-objects", async () => {
    const convo = converse(fixtureAgent({ count: 0 }));
    convo.input.write('{"op":"reboot"}\nnot json\n[1]\n{"op":"stats","extra":1}\n');
    convo.input.end();
    await convo.ended;
    expect(convo.lines.map((l) => JSON.parse(l))).toEqual([
      { error: "bad_request" },
      { error: "bad_request" },
      { error: "bad_request" },
      { error: "bad_request" },
    ]);
  });

  it("answers unavailable when /proc cannot be read, without the error text", async () => {
    const agent = createGuestAgent({
      async readProc() {
        throw Object.assign(new Error("ENOENT: /proc/pressure/memory"), { code: "ENOENT" });
      },
      async trim() {},
    });
    const convo = converse(agent);
    convo.input.write('{"op":"stats"}\n');
    convo.input.end();
    await convo.ended;
    expect(convo.lines).toEqual(['{"error":"unavailable"}']);
  });

  it("closes a connection that stays idle", async () => {
    const convo = converse(fixtureAgent({ count: 0 }), 50);
    await convo.ended;
    expect(convo.lines).toEqual([]);
  });

  it("parses meminfo values in kB into whole MiB", () => {
    expect(parseMemoryStats(PRESSURE, MEMINFO)).toEqual({ psiSome10: 12.5, availableMiB: 400, anonMiB: 1536 });
    expect(() => parseMemoryStats("full avg10=1.00\n", MEMINFO)).toThrow();
    expect(() => parseMemoryStats(PRESSURE, "MemTotal: 1 kB\n")).toThrow();
  });
});

describe("guest client over the Cloud Hypervisor vsock socket", () => {
  let dir: string;
  let vsockPath: string;
  let server: Server;
  let connects: string[];
  let reply: string;
  let sockets: Set<Socket>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hostd-vsock-"));
    vsockPath = join(dir, "vsock.sock");
    connects = [];
    reply = "OK 1073741824\n";
    sockets = new Set();
    const agent = fixtureAgent({ count: 0 });
    // Mimics Cloud Hypervisor's hybrid vsock: a "CONNECT <port>\n" handshake,
    // then the stream belongs to the guest agent.
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let head = "";
      const onData = (chunk: Buffer) => {
        head += chunk.toString("utf8");
        const index = head.indexOf("\n");
        if (index < 0) return;
        socket.off("data", onData);
        connects.push(head.slice(0, index));
        const rest = head.slice(index + 1);
        if (reply === "") return;
        socket.write(reply);
        if (!reply.startsWith("OK ")) {
          socket.end();
          return;
        }
        const input = new PassThrough();
        socket.pipe(input);
        if (rest.length > 0) input.write(rest);
        void serveConnection(agent, input, socket).then(() => socket.end());
      };
      socket.on("data", onData);
    });
    await new Promise<void>((resolve) => server.listen(vsockPath, resolve));
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("connects to guest port 1024 and returns stats", async () => {
    const client = createGuestClient(vsockPath);
    await expect(client.stats(AbortSignal.timeout(2_000))).resolves.toEqual({
      psiSome10: 12.5,
      availableMiB: 400,
      anonMiB: 1536,
    });
    expect(connects).toEqual([`CONNECT ${GUEST_AGENT_PORT}`]);
  });

  it("trims", async () => {
    const client = createGuestClient(vsockPath);
    await expect(client.trim(AbortSignal.timeout(2_000))).resolves.toBeUndefined();
  });

  it("fails unreachable when the VMM refuses the guest port", async () => {
    reply = "ERR\n";
    const client = createGuestClient(vsockPath);
    const error = await client.stats(AbortSignal.timeout(2_000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestError);
    expect((error as GuestError).code).toBe("unreachable");
  });

  it("fails unreachable when the socket does not exist", async () => {
    const client = createGuestClient(join(dir, "missing.sock"));
    const error = await client.stats(AbortSignal.timeout(2_000)).catch((e: unknown) => e);
    expect((error as GuestError).code).toBe("unreachable");
    expect((error as GuestError).message).not.toContain(dir);
  });

  it("times out when the guest never answers", async () => {
    reply = "";
    const client = createGuestClient(vsockPath);
    const error = await client.stats(AbortSignal.timeout(100)).catch((e: unknown) => e);
    expect((error as GuestError).code).toBe("timeout");
  });
});
