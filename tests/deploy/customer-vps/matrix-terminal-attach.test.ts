import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const RUNTIME_ID = "rt_0123456789abcdef0123456789abcdef";
const GENERATION = "gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("matrix-terminal-attach", () => {
  let fixtureRoot: string;
  let homePath: string;
  let runtimeRoot: string;
  let capturePath: string;
  const helperPath = join(process.cwd(), "distro/customer-vps/host-bin/matrix-terminal-attach.mjs");

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "matrix-terminal-attach-"));
    homePath = join(fixtureRoot, "home");
    runtimeRoot = join(fixtureRoot, "runtime");
    capturePath = join(fixtureRoot, "argv.txt");
    const generationRoot = join(runtimeRoot, "generations", GENERATION);
    await mkdir(join(homePath, "system", "terminal-runtimes"), { recursive: true });
    await mkdir(join(homePath, "system", "zellij"), { recursive: true });
    await mkdir(generationRoot, { recursive: true });
    await writeFile(join(generationRoot, "zellij"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_PATH"\n');
    await chmod(join(generationRoot, "zellij"), 0o755);
    await writeFile(join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`), JSON.stringify({
      version: 1,
      runtimeId: RUNTIME_ID,
      sessionName: `matrix-${RUNTIME_ID}`,
      scope: "workspace",
      kind: "agent",
      displayName: "sess_demo",
      cwd: homePath,
      layoutPath: join(homePath, "layout.kdl"),
      generation: GENERATION,
      createdAt: "2026-07-31T12:00:00.000Z",
    }));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("executes only the exact generation binary with a validated argv array", async () => {
    await execFileAsync(process.execPath, [helperPath, RUNTIME_ID, "--index", "0"], {
      env: {
        ...process.env,
        MATRIX_HOME: homePath,
        MATRIX_TERMINAL_RUNTIME_ROOT: runtimeRoot,
        CAPTURE_PATH: capturePath,
      },
      timeout: 5_000,
    });

    await expect(readFile(capturePath, "utf8")).resolves.toBe(
      `attach\nmatrix-${RUNTIME_ID}\n--index\n0\n`,
    );
  });

  it("rejects untyped attach arguments before executing Zellij", async () => {
    await expect(execFileAsync(process.execPath, [helperPath, RUNTIME_ID, "--command", "rm"], {
      env: {
        ...process.env,
        MATRIX_HOME: homePath,
        MATRIX_TERMINAL_RUNTIME_ROOT: runtimeRoot,
        CAPTURE_PATH: capturePath,
      },
      timeout: 5_000,
    })).rejects.toMatchObject({ code: 1 });
    await expect(readFile(capturePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
