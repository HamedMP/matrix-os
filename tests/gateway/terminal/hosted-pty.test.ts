import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { createHostedTerminalPty } from "../../../packages/gateway/src/terminal/hosted-pty.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "t7-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const host = await createHostedTerminalPty({ directory, launch: { command: "/bin/sh", args, cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory, TERM: "xterm-256color" } }, cols: 80, rows: 24 });
  cleanups.push(async () => { await host.stop(); await host.close(); });
  return host;
}
async function viewer(path: string) {
  const socket = connect(path); let output = "";
  socket.setEncoding("utf8"); socket.on("data", bytes => output += bytes);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  cleanups.push(async () => { socket.destroy(); });
  return { socket, get output() { return output; }, send(value: unknown) { socket.write(JSON.stringify(value) + "\n"); } };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!test()) { if (Date.now() > deadline) throw new Error("PTY assertion deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
describe("actual /bin/sh PTY lifetime, independently of source proof", () => {
  it("fences an exited root before any pane attaches and delivers its initial error to that first pane", async () => {
    const host = await fixture(["-c", "printf 'EARLY-EXIT-ERROR\\n'; exit 7"]);
    await host.exited;
    expect(host.running).toBe(false);
    expect(host.signal.aborted).toBe(true);
    const pane = await viewer(host.path);
    const closed = new Promise<void>(resolve => pane.socket.once("close", resolve));
    pane.send({ type: "resize", cols: 80, rows: 24 });
    await closed;
    expect(pane.output).toContain("EARLY-EXIT-ERROR");
  });
  it("hands the pre-attachment startup paint to the first pane without replaying it on later attachment", async () => {
    const host = await fixture(["-c", "printf '\\033[2J\\033[HSTARTUP-PAINT'; printf ready > startup-ready; exec /bin/sh"]);
    const deadline = Date.now() + 4000;
    for (;;) {
      try { expect(await readFile(join(dirname(host.path), "startup-ready"), "utf8")).toBe("ready"); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    // Native output was emitted before a pane existed. Allow the old lossy read path to consume it.
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = await viewer(host.path);
    first.send({ type: "input", data: "printf 'FIRST-ATTACH-%s\\n' ready\n" });
    await until(() => first.output.includes("FIRST-ATTACH-ready"));
    expect(first.output).toContain("\u001b[2J\u001b[HSTARTUP-PAINT");
    first.socket.destroy(); host.closeProof();
    const second = await viewer(host.path);
    second.send({ type: "input", data: "printf 'LATER-ATTACH-%s\\n' ready\n" });
    await until(() => second.output.includes("LATER-ATTACH-ready"));
    expect(second.output).not.toContain("STARTUP-PAINT");
    expect(host.running).toBe(true);
  });
  it("continues input and actual pane resize after detach and proof outage; stop waits for root exit", async () => {
    const host = await fixture(), pid = host.pid;
    const first = await viewer(host.path);
    first.send({ type: "input", data: "printf 'FIRST-%s\\n' ok\n" }); await until(() => first.output.includes("FIRST-ok"));
    first.socket.destroy(); host.closeProof();
    expect(host.pid).toBe(pid); expect(host.running).toBe(true);
    const second = await viewer(host.path);
    second.send({ type: "resize", cols: 113, rows: 41 });
    second.send({ type: "input", data: "stty size; printf 'SECOND-%s\\n' ok\n" });
    await until(() => second.output.includes("41 113") && second.output.includes("SECOND-ok"));
    expect(host.pid).toBe(pid); expect(host.running).toBe(true);
    await host.stop(); expect(host.running).toBe(false);
  });
  it("malformed I/O viewer and controller detach never terminate the native root", async () => {
    const host = await fixture(), bad = await viewer(host.path);
    bad.send({ type: "input", data: "echo forged", ownerId: "fake" }); await until(() => bad.socket.destroyed);
    expect(host.running).toBe(true);
    host.closeProof(); const good = await viewer(host.path);
    good.send({ type: "input", data: "printf 'LIVE-%s\\n' ok\n" }); await until(() => good.output.includes("LIVE-ok"));
  });
});
