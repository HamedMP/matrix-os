import { describe, expect, it } from "vitest";
import {
  buildEchoCommand,
  formatCsv,
  LIVE_TAIL_FROM_SEQ,
  normalizeTerminalText,
  parseArgs,
  parseEchoes,
  summarizeLatencies,
} from "../../scripts/bench-shell-latency.mjs";

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
});
