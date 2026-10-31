import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const verify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../packages/gateway/src/chat/jev-hermes-runtime-pin.js", () => ({ verifyJevHermesRuntimePin: verify }));
import { hermesRoutineBootstrap } from "../../packages/gateway/src/chat/hermes-routine-bootstrap.js";

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
  verify.mockRejectedValueOnce(new Error("Named unsupported/dirty installed runtime fixture"));
  expect(await hermesRoutineBootstrap("/fixture/root", ["-u", "-m", "tui_gateway.entry"], new AbortController().signal)).toBeUndefined();
});
