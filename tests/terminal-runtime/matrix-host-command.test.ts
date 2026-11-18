import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = resolve(__dirname, "../..");
const command = resolve(root, "distro/customer-vps/host-bin/matrix");

// Fault detected (live test on the #3300 preview): `matrix` was not on the terminal PATH,
// so an agent in a Matrix terminal could not run, report to or wait on its helpers.
describe("matrix command in this machine's terminals", () => {
  it("runs the CLI bundled with the release, passing arguments through", async () => {
    expect((await stat(command)).mode & 0o111).not.toBe(0);
    const { stdout } = await run("/bin/sh", [command, "--version"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MATRIX_APP_DIR: root, MATRIX_NODE_BIN: process.execPath },
      timeout: 30_000,
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
