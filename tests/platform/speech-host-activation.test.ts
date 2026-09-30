import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

const hostScript = fileURLToPath(new URL(
  "../../distro/customer-vps/host-bin/matrix-configure-platform-speech.py",
  import.meta.url,
));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "matrix-speech-config-"));
  dirs.push(dir);
  const envPath = join(dir, "host.env");
  const backupPath = join(dir, "host.env.pre-platform-speech");
  const original = [
    "MATRIX_MACHINE_ID=machine-1",
    "MATRIX_RUNTIME_SLOT=primary",
    "MATRIX_PLATFORM_SPEECH_ENABLED=false",
    "MATRIX_PLATFORM_SPEECH_ORIGIN=",
    "MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=",
    "OTHER_SETTING=keep",
    "",
  ].join("\n");
  await writeFile(envPath, original, { mode: 0o640 });
  return { dir, envPath, backupPath, original };
}

function apply(envPath: string, backupPath: string, body: unknown) {
  return spawnSync("python3", ["-c", [
    "import json,runpy,sys",
    "module=runpy.run_path(sys.argv[1],run_name='speech_config_test')",
    "module['apply_config'](sys.argv[2],sys.argv[3],json.loads(sys.stdin.read()))",
  ].join(";"), hostScript, envPath, backupPath], {
    encoding: "utf8",
    input: JSON.stringify(body),
  });
}

const config = {
  machineId: "machine-1",
  runtimeSlot: "primary",
  enabled: true,
  origin: "https://app.matrix-os.com",
  runtimeToken: "a".repeat(64),
};

describe("customer host platform speech activation", () => {
  it("backs up and atomically updates only platform speech settings", async () => {
    const paths = await fixture();
    expect(apply(paths.envPath, paths.backupPath, config).status).toBe(0);
    expect(await readFile(paths.backupPath, "utf8")).toBe(paths.original);
    expect(await readFile(paths.envPath, "utf8")).toBe([
      "MATRIX_MACHINE_ID=machine-1",
      "MATRIX_RUNTIME_SLOT=primary",
      "MATRIX_PLATFORM_SPEECH_ENABLED=true",
      "MATRIX_PLATFORM_SPEECH_ORIGIN=https://app.matrix-os.com",
      `MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=${"a".repeat(64)}`,
      "OTHER_SETTING=keep",
      "",
    ].join("\n"));
  });

  it("supports hosts created before speech settings existed", async () => {
    const paths = await fixture();
    await writeFile(paths.envPath, "MATRIX_MACHINE_ID=machine-1\nMATRIX_RUNTIME_SLOT=primary\nOTHER_SETTING=keep\n");
    expect(apply(paths.envPath, paths.backupPath, config).status).toBe(0);
    const updated = await readFile(paths.envPath, "utf8");
    expect(updated).toContain("MATRIX_PLATFORM_SPEECH_ENABLED=true\n");
    expect(updated).toContain(`MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=${"a".repeat(64)}\n`);
    expect(updated).toContain("OTHER_SETTING=keep\n");
  });

  it.each([
    [{ ...config, machineId: "machine-2" }, "target"],
    [{ ...config, origin: "http://127.0.0.1:9000" }, "configuration"],
    [{ ...config, runtimeToken: "short" }, "configuration"],
  ])("rejects invalid input without changing host.env", async (body, errorFragment) => {
    const paths = await fixture();
    const result = apply(paths.envPath, paths.backupPath, body);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(errorFragment);
    expect(await readFile(paths.envPath, "utf8")).toBe(paths.original);
  });
});
