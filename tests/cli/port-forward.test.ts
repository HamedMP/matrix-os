import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portCommand } from "../../packages/sync-client/src/cli/commands/port.js";
import {
  createForwardWebSocketUrl,
  parseForwardSpec,
  startPortForward,
  type PortForwardHandle,
} from "../../packages/sync-client/src/cli/port-forward.js";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-port-forward-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

async function writeProfiles(root: string) {
  await mkdir(join(root, ".matrixos"), { recursive: true });
  await writeFile(
    join(root, ".matrixos", "profiles.json"),
    JSON.stringify({
      active: "cloud",
      profiles: {
        cloud: {
          platformUrl: "https://platform.example",
          gatewayUrl: "https://gateway.example",
        },
        local: {
          platformUrl: "http://localhost:9000",
          gatewayUrl: "http://127.0.0.1:4000",
        },
      },
    }),
    { flag: "wx" },
  );
}

function captureLogs() {
  const logs: string[] = [];
  const errors: string[] = [];
  const stdout: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
    errors.push(String(line));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  });
  return { logs, errors, stdout };
}

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("matrix port forward", () => {
  it("parses a single port as local loopback to remote loopback", () => {
    expect(parseForwardSpec("3000")).toEqual({
      localHost: "127.0.0.1",
      localPort: 3000,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    });
  });

  it("parses explicit local and remote targets", () => {
    expect(parseForwardSpec("8080:127.0.0.1:3000")).toEqual({
      localHost: "127.0.0.1",
      localPort: 8080,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    });
  });

  it("rejects malformed specs, invalid ports, and non-loopback remote hosts", () => {
    for (const spec of ["", "abc", "0", "65536", "8080:example.com:3000", "8080:127.0.0.1:0"]) {
      expect(() => parseForwardSpec(spec)).toThrowError(
        expect.objectContaining({ code: "invalid_forward_spec" }),
      );
    }
  });

  it("builds forward websocket URLs without leaking bearer auth", () => {
    expect(createForwardWebSocketUrl("https://gateway.example")).toBe("wss://gateway.example/ws/forward");
    expect(createForwardWebSocketUrl("http://127.0.0.1:4000/")).toBe("ws://127.0.0.1:4000/ws/forward");
  });

  it("trims trailing gateway slashes in linear time", () => {
    expect(createForwardWebSocketUrl("https://gateway.example///")).toBe("wss://gateway.example/ws/forward");
    const started = performance.now();
    expect(() => createForwardWebSocketUrl(`https://gateway.example/${"/".repeat(100_000)}x`)).toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("preserves explicit VM and slot routes, rejects ambiguous inputs before binding", async () => {
    for (const path of ["/vm/dev", "/vm/dev/~runtime/slot-1"]) {
      expect(createForwardWebSocketUrl("https://gateway.example" + path + "/")).toBe("wss://gateway.example" + path + "/ws/forward");
    }
    for (const base of ["https://gateway.example/vm/dev/../main", "https://gateway.example/vm/dev/%2e%2e",
      "https://gateway.example/vm/dev//~runtime/slot", "https://gateway.example/vm/dev/~runtime/",
      "https://user:secret@gateway.example", "https://gateway.example?token=secret", "https://gateway.example#",
      "https://gateway.example/%2f", "https://gateway.example/unknown", "file:///vm/dev", "http://gateway.example",
      "https://gateway.example\\vm/dev", "https://gateway.example/vm/de\ntached", "https://@gateway.example"]) {
      expect(() => createForwardWebSocketUrl(base)).toThrowError(expect.objectContaining({ code: "invalid_forward_gateway" }));
    }
    await expect(startPortForward({ ...parseForwardSpec("3000"), localPort: 0, gatewayUrl: "https://gateway.example?token=secret", token: "secret" }))
      .rejects.toThrowError(expect.objectContaining({ code: "invalid_forward_gateway" }));
  });

  it.each([
    "/vm/ab",
    "/vm/a-",
    "/vm/" + "a".repeat(63),
    "/vm/ab/~runtime/a",
    "/vm/ab/~runtime/a-b",
    "/vm/ab/~runtime/" + "a".repeat(32),
  ])("accepts Platform route boundary %s", (path) => {
    expect(createForwardWebSocketUrl("https://gateway.example" + path))
      .toBe("wss://gateway.example" + path + "/ws/forward");
  });

  it.each([
    "/vm/a",
    "/vm/" + "a".repeat(64),
    "/vm/-a",
    "/vm/a_b",
    "/vm/Ab",
    "/vm/ab/~runtime/slot_1",
    "/vm/ab/~runtime/Dev",
    "/vm/ab/~runtime/-dev",
    "/vm/ab/~runtime/dev-",
    "/vm/ab/~runtime/" + "a".repeat(33),
  ])("rejects unsupported Platform route %s before binding", async (path) => {
    const onEvent = vi.fn();
    const result = startPortForward({ ...parseForwardSpec("3000"), localPort: 0,
      gatewayUrl: "https://gateway.example" + path, token: "synthetic", onEvent })
      .then(async handle => { await handle.close(); return handle; });
    await expect(result).rejects.toMatchObject({ code: "invalid_forward_gateway" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(["localhost", "LOCALHOST", "localhost.", "127.1", "2130706433"])(
    "rejects plaintext nonliteral host %s before binding without DNS lookup", async (host) => {
      const onEvent = vi.fn();
      const result = startPortForward({ ...parseForwardSpec("3000"), localPort: 0,
        gatewayUrl: "http://" + host + ":4000", token: "synthetic", onEvent })
        .then(async handle => { await handle.close(); return handle; });
      await expect(result).rejects.toMatchObject({ code: "invalid_forward_gateway" });
      expect(onEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["127.0.0.1", "[::1]"])("allows literal-loopback HTTP host %s", (host) => {
    expect(createForwardWebSocketUrl("http://" + host + ":4000/vm/ab/~runtime/dev"))
      .toBe("ws://" + host + ":4000/vm/ab/~runtime/dev/ws/forward");
  });

  it("uses profile auth and gateway resolution for the command", async () => {
    const root = await tempHome();
    await writeProfiles(root);
    await saveProfileAuth("cloud", {
      accessToken: "cloud-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_cloud",
      handle: "cloud",
    });
    const { stdout } = captureLogs();
    const startForward = vi.fn(async ({ onEvent }: Parameters<typeof startPortForward>[0]): Promise<PortForwardHandle> => {
      onEvent?.("ready", {
        localHost: "127.0.0.1",
        localPort: 3000,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      return {
        localHost: "127.0.0.1",
        localPort: 3000,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        ready: Promise.resolve(),
        closed: Promise.resolve(),
        close: vi.fn(),
      };
    });

    await portCommand.subCommands!.forward.run!({
      args: { spec: "3000", json: true, startForward },
    } as never);

    expect(startForward).toHaveBeenCalledWith(expect.objectContaining({
      gatewayUrl: "https://gateway.example",
      token: "cloud-token",
      localHost: "127.0.0.1",
      localPort: 3000,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    }));
    expect(stdout.join("").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        type: "ready",
        data: {
          localHost: "127.0.0.1",
          localPort: 3000,
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          profile: "cloud",
          gatewayUrl: "https://gateway.example",
        },
      },
    ]);
  });

  it("keeps the active profile unchanged for an explicitly targeted Dev forward", async () => {
    const root = await tempHome(); await writeProfiles(root);
    const path = join(root, ".matrixos", "profiles.json");
    const before = await readFile(path, "utf8");
    const legacy = join(root, ".matrixos", "auth.json");
    await writeFile(legacy, "legacy-main-auth", { flag: "wx" });
    const gateway = "https://gateway.example/vm/owned/~runtime/dev";
    const startForward = vi.fn().mockResolvedValue({ ...parseForwardSpec("3000"), ready: Promise.resolve(), closed: Promise.resolve() });
    captureLogs();
    await portCommand.subCommands!.forward.run!({ args: { spec: "3000", profile: "local", gateway, token: "synthetic", startForward } } as never);
    expect(startForward).toHaveBeenCalledWith(expect.objectContaining({ gatewayUrl: gateway }));
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(legacy, "utf8")).toBe("legacy-main-auth");
  });

  it("fails an explicit named target without creating default profiles on first use", async () => {
    const root = await tempHome(); const { errors } = captureLogs(); const startForward = vi.fn();
    await portCommand.subCommands!.forward.run!({ args: { spec: "3000", json: true, profile: "unregistered", startForward } } as never);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "profile_not_found" } });
    expect(startForward).not.toHaveBeenCalled();
    await expect(readFile(join(root, ".matrixos", "profiles.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an ambiguous explicit gateway before emitting ready or echoing a query credential", async () => {
    const root = await tempHome(); await writeProfiles(root);
    const { errors, stdout } = captureLogs();
    await portCommand.subCommands!.forward.run!({ args: { spec: "3000", profile: "local", json: true,
      gateway: "https://gateway.example/vm/dev?token=private-synthetic", token: "synthetic" } } as never);
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "invalid_forward_gateway" } });
    expect(errors.join("")).not.toContain("private-synthetic");
  });

  it("emits safe JSON errors for invalid specs", async () => {
    const root = await tempHome();
    await writeProfiles(root);
    const { errors } = captureLogs();

    await portCommand.subCommands!.forward.run!({
      args: { spec: "8080:example.com:3000", json: true },
    } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0]!)).toEqual({
      v: 1,
      error: {
        code: "invalid_forward_spec",
        message: "Request failed",
      },
    });
  });

  it("opens a local listener and creates one websocket per accepted TCP connection", async () => {
    class EchoWebSocket extends EventEmitter {
      static instances: EchoWebSocket[] = [];
      sent: unknown[] = [];
      readyState = 1;
      auth?: string;

      constructor(_url: string, options?: { headers?: Record<string, string> }) {
        super();
        this.auth = options?.headers?.Authorization;
        EchoWebSocket.instances.push(this);
        queueMicrotask(() => this.emit("open"));
      }

      send(data: unknown) {
        if (typeof data === "string") {
          this.sent.push(JSON.parse(data));
          queueMicrotask(() => this.emit("message", JSON.stringify({ type: "ready" }), false));
          return;
        }
        const chunk = Buffer.from(data as Buffer);
        this.sent.push(chunk);
        queueMicrotask(() => this.emit("message", Buffer.from("remote-bytes"), true));
      }

      close() {
        this.emit("close");
      }
    }

    const events: string[] = [];
    const handle = await startPortForward({
      gatewayUrl: "https://gateway",
      token: "bearer-token",
      localHost: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      onEvent: (type) => {
        events.push(type);
      },
      idleTimeoutMs: 30_000,
      WebSocketImpl: EchoWebSocket as never,
    });
    await handle.ready;

    const client = await new Promise<Socket>((resolve) => {
      const socket = createConnection(handle.localPort, "127.0.0.1", () => resolve(socket));
    });
    const received = new Promise<Buffer>((resolve) => {
      client.once("data", (chunk) => resolve(Buffer.from(chunk)));
    });
    client.write(Buffer.from("local-bytes"));

    await expect(received).resolves.toEqual(Buffer.from("remote-bytes"));
    expect(EchoWebSocket.instances).toHaveLength(1);
    expect(EchoWebSocket.instances[0]!.auth).toBe("Bearer bearer-token");
    expect(EchoWebSocket.instances[0]!.sent).toEqual([
      { type: "open", host: "127.0.0.1", port: 3000 },
      Buffer.from("local-bytes"),
    ]);

    client.destroy();
    await handle.close();
    expect(events).toContain("ready");
    expect(events).toContain("connection_open");
    expect(events).toContain("connection_close");
  });

  it("splits pending local TCP bytes into bounded websocket frames without mutating options", async () => {
    class DelayedReadyWebSocket extends EventEmitter {
      static instances: DelayedReadyWebSocket[] = [];
      sent: unknown[] = [];
      readyState = 1;

      constructor() {
        super();
        DelayedReadyWebSocket.instances.push(this);
        queueMicrotask(() => this.emit("open"));
      }

      send(data: unknown) {
        this.sent.push(typeof data === "string" ? JSON.parse(data) : Buffer.from(data as Buffer));
      }

      close() {
        this.emit("close");
      }
    }

    const options = {
      gatewayUrl: "https://gateway",
      token: "tok",
      localHost: "127.0.0.1" as const,
      localPort: 0,
      remoteHost: "127.0.0.1" as const,
      remotePort: 3000,
      maxFrameBytes: 4,
      WebSocketImpl: DelayedReadyWebSocket as never,
    };
    const handle = await startPortForward(options);
    await handle.ready;

    expect(options.localPort).toBe(0);
    expect(handle.localPort).toBeGreaterThan(0);

    const client = await new Promise<Socket>((resolve) => {
      const socket = createConnection(handle.localPort, "127.0.0.1", () => resolve(socket));
    });
    const payload = Buffer.from("abcdefghijk");
    client.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const ws = DelayedReadyWebSocket.instances[0]!;
    expect(ws.sent).toEqual([{ type: "open", host: "127.0.0.1", port: 3000 }]);

    ws.emit("message", JSON.stringify({ type: "ready" }), false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const binaryFrames = ws.sent.slice(1) as Buffer[];
    expect(binaryFrames.map((frame) => frame.byteLength)).toEqual([4, 4, 3]);
    expect(Buffer.concat(binaryFrames)).toEqual(payload);

    client.destroy();
    await handle.close();
  });

  it("enforces concurrent connection caps", async () => {
    class HangingWebSocket extends EventEmitter {
      static instances: HangingWebSocket[] = [];
      readyState = 1;
      sent: unknown[] = [];
      closed = false;

      constructor() {
        super();
        HangingWebSocket.instances.push(this);
        queueMicrotask(() => this.emit("open"));
      }

      send(data: unknown) {
        this.sent.push(data);
        if (typeof data === "string") {
          this.emit("message", JSON.stringify({ type: "ready" }));
        }
      }

      close() {
        this.closed = true;
        this.emit("close");
      }
    }

    const handle = await startPortForward({
      gatewayUrl: "https://gateway",
      token: "tok",
      localHost: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      maxConnections: 1,
      WebSocketImpl: HangingWebSocket as never,
    });
    await handle.ready;

    const first = await new Promise<Socket>((resolve) => {
      const socket = createConnection(handle.localPort, "127.0.0.1", () => resolve(socket));
    });
    const second = await new Promise<Socket>((resolve) => {
      const socket = createConnection(handle.localPort, "127.0.0.1", () => resolve(socket));
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(HangingWebSocket.instances).toHaveLength(1);
    expect(second.destroyed).toBe(true);

    first.destroy();
    second.destroy();
    await handle.close();
  });
});
