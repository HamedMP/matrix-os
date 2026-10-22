import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_SHUTDOWN_FORCE_EXIT_MS, RELAY_SHUTDOWN_TIMEOUT_MS, waitForRelayWork } from "../../packages/proxy/src/funded-relay-lifecycle.js";

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Execute each production shutdown function, without starting either HTTP server
// or importing the generic entrypoint's legacy native database dependencies.
function entrypoint(file: "funded-main.ts" | "main.ts", close: (signal?: AbortSignal) => Promise<unknown>, telemetry = async () => undefined) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../../packages/proxy/src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "shutdown");
  if (!declaration) throw new Error(`Missing production shutdown function: ${file}`);
  const body = ts.transpileModule(`let isShuttingDown = false;\n${declaration.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const server = { close: vi.fn() }; const service = { close: vi.fn(close) };
  const posthogErrorTracker = { shutdown: vi.fn(telemetry) };
  const exits: Array<[unknown, number]> = []; const began = Date.now();
  const processFixture = { exit: (code: unknown) => { exits.push([code, Date.now() - began]); } };
  const signals = { timeout(ms: number) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Shutdown deadline", "TimeoutError")), ms);
    return controller.signal;
  } };
  const run = new Function("server", "service", "fundedRelay", "posthogErrorTracker", "process", "AbortSignal", "waitForRelayWork", "RELAY_SHUTDOWN_TIMEOUT_MS", "RELAY_SHUTDOWN_FORCE_EXIT_MS",
    `${body}\nreturn shutdown;`)(server, service, service, posthogErrorTracker, processFixture, signals, waitForRelayWork, RELAY_SHUTDOWN_TIMEOUT_MS, RELAY_SHUTDOWN_FORCE_EXIT_MS) as (signal: string) => Promise<void>;
  return { run, exits, service, server, posthogErrorTracker };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.each(["funded-main.ts", "main.ts"] as const)("%s shutdown behavior", (file) => {
  it("allows confirmed cleanup to finish at seven seconds before the force guard", async () => {
    const f = entrypoint(file, async () => { await pause(7000); return true; });
    const closing = f.run("SIGTERM");
    await vi.advanceTimersByTimeAsync(7000); await closing;
    expect(f.exits).toEqual([[0, 7000]]);
    expect(f.service.close).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(f.server.close).toHaveBeenCalledTimes(1);
  });

  it("exits unsuccessfully for explicitly incomplete cleanup", async () => {
    const f = entrypoint(file, async () => false);
    await f.run("SIGTERM");
    expect(f.exits).toEqual([[1, 0]]);
  });

  it("exits unsuccessfully when cleanup throws", async () => {
    const f = entrypoint(file, async () => { throw new Error("Synthetic close failure"); });
    await f.run("SIGTERM");
    expect(f.exits).toEqual([[1, 0]]);
  });

  it("uses a 9.5 second emergency guard for an uncooperative close", async () => {
    const f = entrypoint(file, () => new Promise(() => undefined));
    void f.run("SIGTERM");
    await vi.advanceTimersByTimeAsync(9500);
    expect(f.exits).toEqual([[1, 9500]]);
  });
});

it("the generic entrypoint does not restart the deadline for telemetry", async () => {
  const f = entrypoint("main.ts", async () => { await pause(7000); return true; }, () => pause(3000));
  void f.run("SIGTERM");
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.exits).toEqual([[1, 9000]]);
});
