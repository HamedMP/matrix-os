// Desktop-link terminals on Windows (spec 2716), where herdr-core has no
// build: the ConPTY core speaks the herdr-core protocol the computer's
// adapter uses. A fake pty stands in for node-pty so this runs in CI on any OS;
// a real Windows desktop has not been tried yet.
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connectHc, type HcConnection } from "@matrix-os/herdr-core-client/client";
import { createWindowsCore, type SpawnWindowsPty, type WindowsPty } from "../../desktop/src/main/desktop-link/windows-core";
import { describeRun } from "../../desktop/src/main/desktop-link/consent";
import { createDesktopLinkGuard } from "../../desktop/src/main/desktop-link/guard";
import { windowsShellEnv } from "../../desktop/src/main/desktop-link/register";
import { encodeFrame, HC_FRAME } from "@matrix-os/herdr-core-client/protocol";

class FakePty implements WindowsPty {
  static all: FakePty[] = [];
  readonly pid = 1000 + FakePty.all.length;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  paused = false;
  private events = new EventEmitter();
  constructor(readonly file: string, readonly args: string, readonly options: Parameters<SpawnWindowsPty>[2]) { FakePty.all.push(this); }
  onData(listener: (data: string) => void) { this.events.on("data", listener); return { dispose: () => this.events.off("data", listener) }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.events.on("exit", listener); return { dispose: () => this.events.off("exit", listener) }; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; this.exit(1); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  print(text: string) { this.events.emit("data", text); }
  exit(code: number) { this.events.emit("exit", { exitCode: code }); }
}

function core(maxPauseMs?: number) {
  FakePty.all = [];
  const spawn = vi.fn((file: string, args: string, options: Parameters<SpawnWindowsPty>[2]) => new FakePty(file, args, options));
  const windows = createWindowsCore({
    spawn, home: "C:\\Users\\hamed", env: { PATH: "C:\\Windows" }, log: () => {}, ...(maxPauseMs ? { maxPauseMs } : {}),
  });
  return { windows, spawn };
}

async function client(windows: ReturnType<typeof core>["windows"]): Promise<HcConnection> {
  const socket = await windows.openStream();
  return connectHc({ open: () => socket, accepts: (hello) => hello.methods.includes("terminal.attach") });
}

const until = (check: () => boolean) => vi.waitFor(() => { if (!check()) throw new Error("waiting"); }, { timeout: 2_000, interval: 5 });

describe("Windows desktop-link core", () => {
  it("answers the herdr-core handshake with the methods the computer's adapter needs", async () => {
    const { windows } = core();
    const connection = await client(windows);
    expect(connection.version).toBe("0.1.22");
    connection.close();
  });

  it("starts PowerShell by default, a PowerShell command line, or argv as given, at home", async () => {
    const { windows, spawn } = core();
    const connection = await client(windows);
    const first = await connection.call("terminal.run", { size: { cols: 100, rows: 30 } }) as { address: string };
    await connection.call("terminal.run", { line: "Get-Date" });
    await connection.call("terminal.run", { argv: ["cmd.exe", "/c", "start", "", "https://example.com"], cwd: "C:\\Users\\hamed\\projects" });
    expect(first.address).toBe("t1");
    expect(spawn.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["powershell.exe", "-NoLogo"],
      ["powershell.exe", "-NoLogo -Command Get-Date"],
      ["cmd.exe", '/c start "" https://example.com'],
    ]);
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cols: 100, rows: 30, cwd: "C:\\Users\\hamed", useConpty: true });
    expect(spawn.mock.calls[2]![2].cwd).toBe("C:\\Users\\hamed\\projects");
    const listed = await connection.call("terminal.list", {}) as { terminals: Array<{ address: string; state: string }> };
    expect(listed.terminals.map((terminal) => [terminal.address, terminal.state])).toEqual([["t1", "live"], ["t2", "live"], ["t3", "live"]]);
    connection.close();
  });

  it("streams output with history, takes typing and size from a writer only, and ends a killed terminal", async () => {
    const { windows } = core();
    const connection = await client(windows);
    const { address } = await connection.call("terminal.run", {}) as { address: string };
    const pty = FakePty.all[0]!;
    pty.print("PS C:\\Users\\hamed> ");
    const output: string[] = [];
    let closed = false;
    const writer = await connection.attach({ terminal: address, cols: 90, rows: 25 }, {
      onData: (chunk, consumed) => { output.push(chunk.toString()); consumed(); },
      onClose: () => { closed = true; },
    });
    await until(() => output.join("").includes("PS C:\\Users\\hamed>"));
    writer.write(Buffer.from("dir\r"));
    writer.resize(100, 30);
    await until(() => pty.written.join("") === "dir\r");
    expect(pty.sizes).toEqual([[90, 25], [100, 30]]);
    // Fault detected (review): typing was read as Latin-1, so "café" or an emoji arrived as other characters.
    // A character split across two frames still arrives whole.
    const typed = Buffer.from("cd café 🚀\r");
    // Split inside "é" and inside the emoji.
    writer.write(typed.subarray(0, 7));
    writer.write(typed.subarray(7, 11));
    writer.write(typed.subarray(11));
    await until(() => pty.written.join("") === "dir\rcd café 🚀\r");
    pty.print("Directory of C:\\Users\\hamed");
    await until(() => output.join("").includes("Directory of"));
    await connection.call("terminal.kill", { terminal: address });
    await until(() => closed);
    expect(pty.killed).toBe(true);
    expect(windows.live()).toBe(0);
    connection.close();
  });

  it("pauses a program whose viewer stops reading, and resumes once it reads again", async () => {
    const { windows } = core();
    const connection = await client(windows);
    const { address } = await connection.call("terminal.run", {}) as { address: string };
    const pty = FakePty.all[0]!;
    const held: Array<() => void> = [];
    await connection.attach({ terminal: address, cols: 80, rows: 24 }, {
      onData: (_chunk, consumed) => { held.push(consumed); },
      onClose: () => {},
    });
    // Past the one-megabyte window without credit: the program waits.
    for (let index = 0; index < 20; index += 1) pty.print("x".repeat(64 * 1024));
    await until(() => pty.paused);
    for (const consumed of held.splice(0)) consumed();
    await until(() => !pty.paused);
    connection.close();
  });

  // Fault detected (Greptile on #3666): a viewer that stopped reading paused the
  // program for everyone, and since a paused program stops producing, its backlog
  // never reached the drop threshold, so the program stayed paused for good.
  it("drops a viewer that stays stalled, so the program runs on for the others", async () => {
    const { windows } = core(50);
    const connection = await client(windows);
    const { address } = await connection.call("terminal.run", {}) as { address: string };
    const pty = FakePty.all[0]!;
    let stalledClosed = false;
    await connection.attach({ terminal: address, cols: 80, rows: 24 }, {
      onData: () => { /* never acknowledges */ },
      onClose: () => { stalledClosed = true; },
    });
    const reader = await client(windows);
    const seen: string[] = [];
    await reader.attach({ terminal: address, cols: 80, rows: 24 }, {
      onData: (chunk, consumed) => { seen.push(chunk.toString()); consumed(); },
      onClose: () => {},
    });
    for (let index = 0; index < 20; index += 1) pty.print("x".repeat(64 * 1024));
    await until(() => pty.paused);
    await until(() => stalledClosed && !pty.paused);
    pty.print("after");
    await until(() => seen.join("").includes("after"));
    connection.close();
    reader.close();
  });

  it("caps live terminals, refuses unknown methods, and ends every terminal when the app quits", async () => {
    const { windows } = core();
    const connection = await client(windows);
    for (let index = 0; index < 16; index += 1) await connection.call("terminal.run", {});
    await expect(connection.call("terminal.run", {})).rejects.toMatchObject({ kind: "busy" });
    await expect(connection.call("machine.exec", { argv: ["whoami"] })).rejects.toMatchObject({ kind: "method_not_found" });
    windows.dispose();
    expect(FakePty.all.every((pty) => pty.killed)).toBe(true);
    await expect(windows.openStream()).rejects.toThrow();
  });

  it("behind the guard, refuses a folder outside the user's home on Windows paths", async () => {
    const guard = createDesktopLinkGuard({
      home: "C:\\Users\\hamed", computerName: "matrix-demo", pathApi: path.win32,
      resolveFolder: async (folder) => folder,
    });
    await guard.push(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } })}\n`));
    const run = (id: number, cwd: string) => encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "terminal.run", params: { cwd } })));
    expect((await guard.push(run(2, "C:\\Windows\\System32"))).toComputer).toHaveLength(1);
    expect((await guard.push(run(3, "D:\\Users\\hamed"))).toComputer).toHaveLength(1);
    expect((await guard.push(run(4, "..\\other"))).toComputer).toHaveLength(1);
    const allowed = await guard.push(run(5, "projects\\app"));
    expect(allowed.toComputer).toEqual([]);
    expect(allowed.forwarded[0]!.toString()).toContain("C:\\\\Users\\\\hamed\\\\projects\\\\app");
  });

  // Fault detected (review, P1): approvals were kept by address, and this core numbers
  // terminals from t1 again each launch, so an approval for one terminal covered whatever
  // later took its address. The guard keys approvals by address and start time.
  it("tells a terminal from a later one at the same address by its start time", async () => {
    const started = async () => {
      const { windows } = core();
      const connection = await client(windows);
      const ran = await connection.call("terminal.run", { line: "Get-Date" }) as { address: string; created_ms: number };
      const listed = await connection.call("terminal.list", {}) as { terminals: Array<{ address: string; created_ms: number; cwd: string }> };
      connection.close();
      windows.dispose();
      return { ran, listed: listed.terminals[0]! };
    };
    const first = await started();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await started();
    expect([first.ran.address, second.ran.address]).toEqual(["t1", "t1"]);
    expect(first.listed).toMatchObject({ address: "t1", created_ms: first.ran.created_ms, cwd: "C:\\Users\\hamed" });
    expect(second.ran.created_ms).toBeGreaterThan(first.ran.created_ms);
  });

  // Fault detected (review, P2): the approval quoted argv one way and node-pty joined it
  // another, so an argument already in quotes reached the program split in two.
  it("starts a program with exactly the command line the owner's approval showed", async () => {
    const { windows, spawn } = core();
    const connection = await client(windows);
    const argv = ["C:\\Program Files\\tool.exe", '"a b"', "c d", 'say "hi"', "tail\\"];
    await connection.call("terminal.run", { argv });
    const shown = describeRun({ argv }, "win32")!;
    const [file, args] = spawn.mock.calls[0]!;
    expect(`"${file}" ${args}`).toBe(shown);
    expect(args).toBe('"\\"a b\\"" "c d" "say \\"hi\\"" tail\\');
    await expect(connection.call("terminal.run", { argv: ['C:\\x"y.exe'] })).rejects.toThrow();
    connection.close();
  });

  // Fault detected (Greptile on #3750): a replay was only the last 512 KiB of raw output,
  // so once a long-running program's first paint scrolled out, a new viewer lost its heading.
  it("replays the whole current screen to a new viewer however much output came before", async () => {
    const { windows } = core();
    const connection = await client(windows);
    const { address } = await connection.call("terminal.run", { size: { cols: 80, rows: 24 } }) as { address: string };
    const pty = FakePty.all[0]!;
    pty.print("\x1b[1;1HDASHBOARD TITLE");
    for (let index = 0; index < 8_000; index += 1) pty.print(`\x1b[10;1Htick ${index} ${"x".repeat(60)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replay: Buffer[] = [];
    await connection.attach({ terminal: address, cols: 80, rows: 24, observe: true }, {
      onData: (chunk, consumed) => { replay.push(Buffer.from(chunk)); consumed(); },
      onClose: () => {},
    });
    await until(() => Buffer.concat(replay).toString().includes("tick 7999"));
    const { default: headless } = await import("@xterm/headless");
    const screen = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => screen.write(Buffer.concat(replay), resolve));
    expect(screen.buffer.active.getLine(0)?.translateToString(true)).toBe("DASHBOARD TITLE");
    expect(screen.buffer.active.getLine(9)?.translateToString(true)).toContain("tick 7999");
    screen.dispose();
    connection.close();
    windows.dispose();
  });

  it("gives PowerShell the user's environment without Electron's or Matrix's own variables", () => {
    expect(windowsShellEnv({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\hamed", ELECTRON_RUN_AS_NODE: "1", MATRIX_SECRET: "x", NODE_OPTIONS: "--x" }))
      .toEqual({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\hamed" });
  });
});
