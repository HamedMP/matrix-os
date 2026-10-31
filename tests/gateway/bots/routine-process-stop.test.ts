import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutineProcessStop } from "./routine-process-stop.js";

const children: { child: ChildProcess; ended: Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, ended }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
  }));
});

async function launch(exitOnTerm = 0) {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => process.exit(${exitOnTerm}));
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const ended = new Promise<void>(done => child.once("exit", () => done()));
  children.push({ child, ended });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic child readiness timed out")), 3000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout!.once("data", () => { clearTimeout(timer); done(); });
  });
  return { child, ended, stop: createRoutineProcessStop(child, ended) };
}

describe("built routine qualification child exits", () => {
  it("accepts a confirmed zero exit and repeated cleanup", async () => {
    const client = await launch();
    await client.stop();
    expect(client.child.exitCode).toBe(0);
    expect(client.child.signalCode).toBeNull();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("rejects a failed graceful shutdown after the last successful observation", async () => {
    const client = await launch(7);
    await expect(client.stop()).rejects.toThrow("Unexpected child exit");
    expect(client.child.exitCode).toBe(7);
    await expect(client.stop()).rejects.toThrow("Unexpected child exit");
  });

  it("rejects a crash that happened before cleanup was requested", async () => {
    const client = await launch(9);
    client.child.kill("SIGTERM");
    await client.ended;
    await expect(client.stop()).rejects.toThrow("Unexpected child exit");
  });

  it("rejects an external signal and cannot authorize that crash afterwards", async () => {
    const client = await launch();
    client.child.kill("SIGKILL");
    await client.ended;
    await expect(client.stop()).rejects.toThrow("Unexpected child exit");
    await expect(client.stop(true)).rejects.toThrow("Unexpected child exit");
  });

  it("accepts only its deliberately requested crash and preserves that intent for cleanup", async () => {
    const client = await launch();
    await client.stop(true);
    expect(client.child.exitCode).toBeNull();
    expect(client.child.signalCode).toBe("SIGKILL");
    await expect(client.stop()).resolves.toBeUndefined();
  });
});
