import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/activate-speech-preview.py");
const token = "a".repeat(64);

function invoke(path: string, overrides: string[] = []) {
  return spawnSync("python3", [script, "--env-file", path,
    "--handle", "pr-1620", "--machine-id", "machine_1620", "--owner-id", "owner_1620",
    "--runtime-slot", "pr-1620", "--speech-origin", "https://pr-1620---matrix-platform-preview-abc.ew.a.run.app",
    "--speech-runtime-token", token, ...overrides], { encoding: "utf8" });
}

describe("speech preview host activation", () => {
  it("updates only the dedicated speech capability and preserves funded AI", () => {
    const dir = mkdtempSync(join(tmpdir(), "speech-preview-"));
    const path = join(dir, "host.env");
    writeFileSync(path, [
      "MATRIX_HANDLE=pr-1620", "MATRIX_MACHINE_ID=machine_1620", "MATRIX_CLERK_USER_ID=owner_1620", "MATRIX_RUNTIME_SLOT=pr-1620",
      "PLATFORM_INTERNAL_URL=https://platform.matrix-os.com", "MATRIX_FUNDED_AI_ENABLED=true", "MATRIX_FUNDED_AI_RUNTIME_TOKEN=funded-token",
      "MATRIX_PLATFORM_SPEECH_ENABLED=false", "MATRIX_PLATFORM_SPEECH_ORIGIN=old", "MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=old-token", "",
    ].join("\n"), { mode: 0o640 });
    expect(invoke(path).status).toBe(0);
    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("PLATFORM_INTERNAL_URL=https://platform.matrix-os.com");
    expect(updated).toContain("MATRIX_FUNDED_AI_RUNTIME_TOKEN=funded-token");
    expect(updated).toContain("MATRIX_PLATFORM_SPEECH_ENABLED=true");
    expect(updated.match(/^MATRIX_PLATFORM_SPEECH_ORIGIN=/gm)).toHaveLength(1);
    expect(updated).toContain(`MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=${token}`);
  });

  it("rejects identity mismatches and symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "speech-preview-"));
    const path = join(dir, "host.env");
    writeFileSync(path, "MATRIX_HANDLE=pr-1621\nMATRIX_MACHINE_ID=machine_1620\nMATRIX_CLERK_USER_ID=owner_1620\nMATRIX_RUNTIME_SLOT=pr-1620\n");
    expect(invoke(path).status).not.toBe(0);
    const link = join(dir, "linked.env");
    symlinkSync(path, link);
    expect(invoke(link).status).not.toBe(0);
  });
});
