import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createUserSystemdTerminalRuntime } from "../../packages/terminal-runtime/src/user-systemd-controller.js";

const runtimeId = `rt_${"a".repeat(32)}`;
const generation = `gen_${"b".repeat(64)}`;
const invocationId = "c".repeat(32);
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each([0, 1])("publishes readiness only after a successful background launch (exit %i)", async (exitCode) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-keeper-ready-"));
  paths.push(homePath);
  const terminalRuntimeRoot = join(homePath, "installed");
  const generationPath = join(terminalRuntimeRoot, "generations", generation);
  await mkdir(generationPath, { recursive: true });
  const keeperPath = join(generationPath, "matrix-terminal-user-keeper.mjs");
  await writeFile(keeperPath, await readFile("distro/customer-vps/host-bin/matrix-terminal-user-keeper.mjs"));
  await writeFile(join(generationPath, "zellij"), "fixture binary\n");
  await chmod(join(generationPath, "zellij"), 0o755);
  const layoutPath = join(homePath, "layout.kdl");
  await writeFile(layoutPath, "layout { pane }\n");
  const preloadPath = join(homePath, "external-command-fixture.mjs");
  await writeFile(preloadPath, `
    import cp from 'node:child_process';
    import {EventEmitter} from 'node:events';
    import {syncBuiltinESMExports} from 'node:module';
    cp.spawn = (command, args) => {
      if(command !== '/usr/bin/script') throw new Error('Unexpected external command');
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = () => true;
      if(args[1].includes('--create-background')) queueMicrotask(() => {child.exitCode=${exitCode};child.emit('exit',${exitCode},null);});
      return child;
    };
    syncBuiltinESMExports();
  `);
  const runtime = createUserSystemdTerminalRuntime({ homePath, uid: 1001, generation, terminalRuntimeRoot,
    readinessTimeoutMs: 50, readinessStabilityMs: 0, capacityAdmission: async () => undefined,
    runCommand: async (command, args) => {
      if (command !== "systemctl") throw new Error("Unexpected IPC probe");
      if (args.includes("start")) await promisify(execFile)(process.execPath, ["--import", preloadPath, keeperPath, runtimeId],
        { timeout: 3_000, env: { ...process.env, MATRIX_HOME: homePath, MATRIX_TERMINAL_RUNTIME_ROOT: terminalRuntimeRoot, INVOCATION_ID: invocationId } });
      return { stdout: `ActiveState=active\nInvocationID=${invocationId}\n`, stderr: "" };
    },
  });
  const result = runtime.create({ runtimeId, scope: "workspace", kind: "agent", displayName: "Chat", cwd: homePath, layoutPath });
  if (exitCode === 0) await expect(result).resolves.toMatchObject({ lifecycle: "running" });
  else await expect(result).rejects.toThrow("Terminal runtime unavailable");
});

it.each(["old invocation", "old generation", "old descriptor", "partial write", "oversized", "missing"])(
  "waits for a current keeper signal without probing Zellij (%s)", async (initialSignal) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-ready-"));
  paths.push(homePath);
  const terminalRuntimeRoot = join(homePath, "installed");
  const generationPath = join(terminalRuntimeRoot, "generations", generation);
  await mkdir(generationPath, { recursive: true });
  await writeFile(join(generationPath, "matrix-terminal-user-keeper.mjs"),
    "// matrix-terminal-readiness: invocation-v1\n");
  const layoutPath = join(homePath, "layout.kdl");
  await writeFile(layoutPath, "layout { pane }\n");
  let showCount = 0;
  const runtime = createUserSystemdTerminalRuntime({ homePath, uid: 1001, generation, terminalRuntimeRoot,
    readinessTimeoutMs: 1_000, readinessStabilityMs: 0, capacityAdmission: async () => undefined,
    runCommand: async (command, args) => {
      if (command !== "systemctl") throw new Error("readiness probe crashed uninitialized Zellij");
      if (args.includes("show")) {
        showCount += 1;
        const descriptor = JSON.parse(await readFile(join(homePath, "system/terminal-runtimes", `${runtimeId}.json`), "utf8"));
        const first = showCount === 1;
        const signal = JSON.stringify({ version: 1,
          generation: first && initialSignal === "old generation" ? `gen_${"e".repeat(64)}` : generation,
          createdAt: first && initialSignal === "old descriptor" ? "2020-01-01T00:00:00.000Z" : descriptor.createdAt,
          invocationId: first && initialSignal === "old invocation" ? "d".repeat(32) : invocationId,
        });
        if (!first || initialSignal !== "missing") {
          await writeFile(join(homePath, "system/terminal-runtimes", `${runtimeId}.ready.json`),
            first && initialSignal === "partial write" ? "{" : signal + (first && initialSignal === "oversized" ? " ".repeat(2_000) : ""));
        }
        return { stdout: `ActiveState=active\nInvocationID=${invocationId}\n`, stderr: "" };
      }
      return { stdout: "active\n", stderr: "" };
    },
  });
  await expect(runtime.create({ runtimeId, scope: "workspace", kind: "agent", displayName: "Chat", cwd: homePath, layoutPath }))
    .resolves.toMatchObject({ lifecycle: "running" });
  expect(showCount).toBeGreaterThanOrEqual(2);
});
