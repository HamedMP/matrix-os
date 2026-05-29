import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachEchoClient,
  attachUrl,
  buildEchoCommand,
  createSession,
  formatCsv,
  LIVE_TAIL_FROM_SEQ,
  normalizeTerminalText,
  parseArgs,
  parseEchoes,
  resolveProfile,
  summarizeLatencies,
  summarizeServerLoad,
} from "../../scripts/bench-shell-latency.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bench-shell-latency script helpers", () => {
  it("parses the recommended benchmark flags", () => {
    const args = parseArgs([
      "--session",
      "bench-mobile",
      "--rates",
      "1,10,30",
      "--duration",
      "5",
      "--burst",
      "100",
      "--concurrency",
      "1,5,10",
      "--force",
      "--json",
    ]);

    expect(args).toMatchObject({
      session: "bench-mobile",
      rates: [1, 10, 30],
      durationSeconds: 5,
      burstCount: 100,
      concurrency: [1, 5, 10],
      force: true,
      json: true,
    });
  });

  it("rejects non-benchmark session names", () => {
    expect(() => parseArgs(["--session", "main"])).toThrow(/Benchmark session/);
  });

  it("uses the live-tail cursor constant for benchmark attaches", () => {
    expect(LIVE_TAIL_FROM_SEQ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps bearer tokens out of terminal websocket URLs", () => {
    const url = attachUrl("https://app.matrix-os.com", "bench-main");

    expect(url).toBe(`wss://app.matrix-os.com/ws/terminal/session?session=bench-main&fromSeq=${LIVE_TAIL_FROM_SEQ}`);
    expect(url).not.toContain("token=");
  });

  it("builds a deterministic raw echo command", () => {
    const command = buildEchoCommand();

    expect(command).toContain("node -e");
    expect(command).toContain("Buffer.from");
    expect(command).toContain("base64");
    expect(command).not.toContain("MATRIX_BENCH_READY");
    expect(command).not.toContain("ECHO");
  });

  it("parses chunked echo output and readiness", () => {
    const echoes: Array<{ hex: string; remoteTime: number }> = [];
    const state = { buffer: "" };

    expect(parseEchoes(state, "MATRIX_BENCH_READY 1770000000000\nECHO 4", (echo) => echoes.push(echo))).toEqual({
      ready: true,
    });
    expect(parseEchoes(state, "1 1770000000001\nECHO 42 1770000000002\n", (echo) => echoes.push(echo))).toEqual({
      ready: true,
    });

    expect(echoes).toEqual([
      { hex: "41", remoteTime: 1770000000001 },
      { hex: "42", remoteTime: 1770000000002 },
    ]);
  });

  it("creates benchmark sessions with the deterministic echo command", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const cmd = buildEchoCommand();

    await createSession({ gateway: "https://gateway.example", token: "secret" }, "bench-main", cmd);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/terminal/sessions", "https://gateway.example"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "bench-main", cmd }),
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("allows direct gateway and token mode without profile files", async () => {
    await expect(resolveProfile({
      profile: "cloud",
      gateway: "https://gateway.example",
      token: "secret",
    }, "/tmp/matrix-profile-does-not-exist")).resolves.toEqual({
      profile: "cloud",
      gateway: "https://gateway.example",
      token: "secret",
    });
  });

  it("does not mark an attached benchmark client ready before the echo program emits readiness", async () => {
    class FakeWs extends EventEmitter {
      static instances: FakeWs[] = [];
      sent: unknown[] = [];
      readyState = 0;

      constructor(readonly url: string, readonly init: unknown) {
        super();
        FakeWs.instances.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.emit("open");
        }, 0);
      }

      send(raw: string) {
        this.sent.push(JSON.parse(raw));
      }

      close() {
        this.emit("close");
      }
    }

    const attaching = attachEchoClient({
      profile: { gateway: "https://gateway.example", token: "secret" },
      session: "bench-main",
      WebSocket: FakeWs,
      startupTimeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const ws = FakeWs.instances[0];
    ws.emit("message", JSON.stringify({ type: "attached" }));
    ws.emit("message", JSON.stringify({ type: "output", data: "shell prompt\n" }));
    let settled = false;
    void attaching.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toBe(false);

    ws.emit("message", JSON.stringify({ type: "output", data: "MATRIX_BENCH_READY 1770000000000\n" }));
    const client = await attaching;

    expect(client.state.ready).toBe(true);
    expect(ws.sent).toContainEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("normalizes ANSI terminal rendering before parsing echoes", () => {
    const echoes: Array<{ hex: string; remoteTime: number }> = [];
    const state = { buffer: "" };
    const chunk = "\u001b[?25l\u001b[1;1HECHO 21 1770000000001\r\n\u001b[?25h";

    parseEchoes(state, chunk, (echo) => echoes.push(echo));

    expect(normalizeTerminalText(chunk)).toContain("ECHO 21 1770000000001");
    expect(echoes).toEqual([{ hex: "21", remoteTime: 1770000000001 }]);
  });

  it("computes p50/p95/p99/max latency summaries", () => {
    expect(summarizeLatencies([10, 20, 30, 40, 50], 5, 100, 0)).toEqual({
      count: 5,
      p50: 30,
      p95: 50,
      p99: 50,
      max: 50,
      inputBytes: 5,
      outputBytes: 100,
      disconnects: 0,
    });
  });

  it("formats CSV output for persisted benchmark runs", () => {
    expect(formatCsv([
      {
        mode: "rate",
        rate: 10,
        concurrency: 1,
        sent: 300,
        received: 300,
        missing: 0,
        p50: 42,
        p95: 88,
        p99: 141,
        max: 220,
        inputBytesPerSec: 10,
        outputBytesPerSec: 120,
        disconnects: 0,
      },
    ])).toContain("rate,10,1,300,300,0,42,88,141,220,10,120,0");
  });

  it("summarizes server load samples captured during a run", () => {
    expect(summarizeServerLoad([
      {
        loadAverage: "1.00 0.50 0.25 1/100 123",
        gatewayFdCount: 10,
        gateway: [{ cpuPercent: 4, rssKb: 100 }, { cpuPercent: 6, rssKb: 200 }],
        zellij: [{ cpuPercent: 2, rssKb: 50 }],
      },
      {
        loadAverage: "3.00 1.50 0.75 1/100 123",
        gatewayFdCount: 20,
        gateway: [{ cpuPercent: 10, rssKb: 300 }],
        zellij: [{ cpuPercent: 5, rssKb: 80 }],
      },
    ])).toMatchObject({
      sampleCount: 2,
      errors: 0,
      gatewayCpuPercent: { avg: 10, p95: 10, max: 10 },
      gatewayRssKb: { avg: 300, p95: 300, max: 300 },
      gatewayFdCount: { avg: 15, p95: 20, max: 20 },
      zellijCpuPercent: { avg: 3.5, p95: 5, max: 5 },
      zellijRssKb: { avg: 65, p95: 80, max: 80 },
      load1: { avg: 2, p95: 3, max: 3 },
    });
  });
});
