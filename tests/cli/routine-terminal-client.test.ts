import { executeRoutineOperation } from "../../packages/sync-client/src/cli/routine-client.js";
import { ROUTINE_CLI_SAFE_ERRORS } from "@matrix-os/contracts/routine-cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { executeTerminalRoutineOperation, validateTerminalBrokerLocation } from "../../packages/sync-client/src/cli/routine-terminal-client.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe("ordinary CLI Terminal broker discovery is a location only", () => {
  it.each(['http://localhost/x', '/tmp/routine.sock', 'unix:///tmp/x', '/tmp/matrix-terminal-' + 'a'.repeat(32) + '/../routine.sock', '/tmp/matrix-terminal-' + 'a'.repeat(32) + '/routine.sock?owner=me'])('rejects invalid location %s', value => {
    expect(() => validateTerminalBrokerLocation(value)).toThrow();
  });
  it("keeps write direction open until validated result; sends only strict operation", async () => {
    const parent = await mkdtemp("/tmp/t7cli-"); cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const dir = join(parent, `matrix-terminal-${randomUUID().replaceAll('-', '')}`); await mkdir(dir, { mode: 0o700 });
    const path = join(dir, 'routine.sock'); let received = '', ended = false;
    const server = createServer(socket => { socket.setEncoding('utf8'); socket.on('end', () => ended = true); socket.on('data', data => {
      received += data;
      setTimeout(() => { expect(ended).toBe(false); socket.end(JSON.stringify({v:1,error:{code:'permission_denied',message:ROUTINE_CLI_SAFE_ERRORS.permission_denied}})+'\n'); }, 20);
    }); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); }); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    await expect(executeTerminalRoutineOperation({ operation: 'list' }, new AbortController().signal, path)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(JSON.parse(received)).toEqual({ operation: 'list' });
  });
});

// Real sockets, no source/capability fixture: only uncertain transport outcomes.
describe("Terminal mutation uncertainty", () => {
  async function broker(receive: (socket: import("node:net").Socket, request: string) => void) {
    const parent = await mkdtemp("/tmp/t7cli-"); cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const dir = join(parent, `matrix-terminal-${randomUUID().replaceAll("-", "")}`); await mkdir(dir, { mode: 0o700 });
    const path = join(dir, "routine.sock"), requests: string[] = [];
    let connections = 0, cancelled = 0;
    const sockets = new Set<import("node:net").Socket>(); // Test bounded to one client, drained below.
    const server = createServer(socket => {
      connections++; sockets.add(socket); socket.setEncoding("utf8"); let bytes = "";
      socket.on("end", () => cancelled++); socket.on("close", () => sockets.delete(socket));
      socket.on("data", data => { bytes += data; if (bytes.endsWith("\n")) { requests.push(bytes); receive(socket, bytes); bytes = ""; } });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    cleanup.push(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); });
    return { path, requests, connections: () => connections, cancelled: () => cancelled };
  }
  it.each(["eof", "abort", "malformed", "mismatch", "oversized"])("preserves original UUID with one request after %s", async failure => {
    const controller = new AbortController(), requestId = randomUUID();
    const operation = { operation: "pause", routineId: "rt_" + "a".repeat(24), baseRevision: 1, requestId } as const;
    const b = await broker(socket => {
      if (failure === "eof") socket.end();
      if (failure === "abort") controller.abort();
      if (failure === "malformed") socket.write("{not-json}\n");
      if (failure === "mismatch") socket.write(JSON.stringify({ v: 1, ok: true, data: { kind: "unknown", requestId: randomUUID(), disposition: "unknown", reconcile: true } }) + "\n");
      if (failure === "oversized") socket.write("x".repeat(131074));
    });
    await expect(executeTerminalRoutineOperation(operation, controller.signal, b.path)).resolves.toEqual({ kind: "unknown", requestId, disposition: "unknown", reconcile: true });
    await vi.waitFor(() => expect(b.cancelled()).toBe(1));
    expect(b.connections()).toBe(1); expect(b.requests.map(value => JSON.parse(value))).toEqual([operation]);
  });
  it("does not connect to broker when private IPC is present but disconnected", async () => {
    const b = await broker(() => { throw new Error("Unexpected fallback"); });
    const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
    const oldLocation = process.env.MATRIX_TERMINAL_ROUTINE_SOCKET;
    Object.defineProperty(process, "send", { configurable: true, value: vi.fn() });
    Object.defineProperty(process, "connected", { configurable: true, value: false });
    process.env.MATRIX_TERMINAL_ROUTINE_SOCKET = b.path;
    try {
      await expect(executeRoutineOperation({ operation: "list" }, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
      expect(process.send).not.toHaveBeenCalled(); expect(b.connections()).toBe(0); expect(b.requests).toEqual([]);
    } finally {
      if (send) Object.defineProperty(process, "send", send); else delete process.send;
      if (connected) Object.defineProperty(process, "connected", connected); else delete (process as Partial<NodeJS.Process>).connected;
      if (oldLocation === undefined) delete process.env.MATRIX_TERMINAL_ROUTINE_SOCKET; else process.env.MATRIX_TERMINAL_ROUTINE_SOCKET = oldLocation;
    }
  });
});
