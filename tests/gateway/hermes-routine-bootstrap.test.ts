import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const git = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string>>());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(actual.execFile.bind(undefined), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (file: string, args: string[], options: unknown) =>
      file === "/usr/bin/git" ? { stdout: await git(args), stderr: "" } : promisify(actual.execFile)(file, args, options as never),
  });
  return { ...actual, execFile };
});
import { hermesRoutineBootstrap } from "../../packages/gateway/src/chat/hermes-routine-bootstrap.js";
import { verifyJevHermesRuntimePin } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";

const routinePin = "d337b736aa1e8ebecfab043842d13e4a2d2f48a3";
const jevPin = "e06df9c2eae6901f4c88f464e0ae6e753c0428b8";
const ordinary = ["-u", "-m", "tui_gateway.entry"];
const install = (pin: string, extra: string[] = []) =>
  git.mockImplementation(async args => args.includes("rev-parse") ? pin + "\n" : args.includes("ls-files") ? extra.join("\0") : "");
beforeEach(() => { git.mockReset(); install(routinePin); });


it("composes the public registration around the existing browser bootstrap, preserves isolation flags and hashes exact resource bytes", async () => {
  const existing = ["-I", "-S", "-B", "-u", "-c", "import runpy\nbrowser_config = 'owned existing setup'\nrunpy.run_module('tui_gateway.entry', run_name='__main__')"];
  const result = await hermesRoutineBootstrap("/fixture/root", existing, new AbortController().signal);
  expect(result!.slice(0, -1)).toEqual(["-B", "-X", "pycache_prefix=/dev/null/matrix-routine-cache", ...existing.slice(0, -1)]);
  const code = result!.at(-1)!;
  expect(code).toContain("browser_config = 'owned existing setup'");
  expect(code).toContain(createHash("sha256").update(await readFile("packages/gateway/src/chat/hermes-routine-tool.py")).digest("hex"));
  expect(code.match(/runpy.run_module\('tui_gateway.entry'/g)).toHaveLength(1);
  expect(code).not.toMatch(/save_config|enable_plugin|AIAgent\(|_load_plugin|HERMES_BUNDLED_PLUGINS/);
  await promisify(execFile)("python3", ["-I", "-S", "-B", "-c", "import ast,sys; ast.parse(sys.argv[1])", code], { timeout: 5000 });
});
it("unsupported bootstrap and failed exact-pin check leave the ordinary native launch available", async () => {
  expect(await hermesRoutineBootstrap("/fixture/root", ["-m", "unowned.entry"], new AbortController().signal)).toBeUndefined();
  git.mockRejectedValueOnce(new Error("Named unsupported/dirty installed runtime fixture"));
  expect(await hermesRoutineBootstrap("/fixture/root", ["-u", "-m", "tui_gateway.entry"], new AbortController().signal)).toBeUndefined();
});

it("accepts only the routine handshake revision and preserves the distinct Jev gate", async () => {
  const signal = new AbortController().signal;
  expect(await hermesRoutineBootstrap("/fixture/root", ordinary, signal)).toEqual(expect.any(Array));
  expect(git.mock.calls.map(([args]) => args.at(-1))).toEqual(["HEAD", "--", ":(exclude,glob)**/__pycache__/*.cpython-*.pyc", ":(exclude,glob)**/__pycache__/*.cpython-*.pyc"]);
  await expect(verifyJevHermesRuntimePin("/fixture/root", signal)).rejects.toThrow();
  install(jevPin);
  expect(await hermesRoutineBootstrap("/fixture/root", ordinary, signal)).toBeUndefined();
  await expect(verifyJevHermesRuntimePin("/fixture/root", signal)).resolves.toBeUndefined();
});

it("keeps routine bootstrap disabled for an importable addition even at its supported revision", async () => {
  install(routinePin, ["sitecustomize.py"]);
  expect(await hermesRoutineBootstrap("/fixture/root", ordinary, new AbortController().signal)).toBeUndefined();
});
