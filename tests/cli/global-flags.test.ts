import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-cli-global-flags-"));
  roots.push(root);
  return root;
}

function runCli(entry: string, args: string[], home: string) {
  const tsxLoader = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  return spawnSync(process.execPath, ["--import", tsxLoader, entry, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      MATRIX_HOME: join(home, "matrix-home"),
    },
    encoding: "utf-8",
  });
}

function firstOutputLine(output: string): string {
  return output.trim().split("\n")[0] ?? "";
}

function expectOutput(output: string, result: ReturnType<typeof runCli>): string {
  const first = firstOutputLine(output);
  expect(first, JSON.stringify({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  })).not.toBe("");
  return first;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI leading global flags", () => {
  it("honors --json before a published profile command", async () => {
    const home = await tempHome();
    const bin = join(process.cwd(), "packages/sync-client/src/cli/index.ts");

    const result = runCli(bin, ["--json", "profile", "ls"], home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(expectOutput(result.stdout, result))).toEqual({
      v: 1,
      ok: true,
      data: {
        active: "cloud",
        profiles: [
          {
            name: "cloud",
            active: true,
            platformUrl: "https://app.matrix-os.com",
            gatewayUrl: "https://app.matrix-os.com",
          },
          {
            name: "local",
            active: false,
            platformUrl: "http://localhost:9000",
            gatewayUrl: "http://localhost:4000",
          },
        ],
      },
    });
  });

  it("honors --profile before a published shell command", async () => {
    const home = await tempHome();
    const bin = join(process.cwd(), "packages/sync-client/src/cli/index.ts");

    const result = runCli(bin, ["--profile", "local", "shell", "ls", "--json"], home);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(expectOutput(result.stderr, result))).toEqual({
      v: 1,
      error: {
        code: "not_authenticated",
        message: 'Not logged in for profile "local". Run `matrix login` first.',
      },
    });
  });

  it("redirects root matrixos commands with leading global flags", async () => {
    const home = await tempHome();
    const bin = join(process.cwd(), "bin/matrixos.ts");

    const result = runCli(bin, ["--json", "profile", "ls"], home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(expectOutput(result.stdout, result)).data.active).toBe("cloud");
  });
});
