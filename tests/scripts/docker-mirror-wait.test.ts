import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

describe("Docker restart waits for an accepted mirror content hash", () => {
  it.each([true, false])("accepts only a matching persisted hash (matching=%s)", (matching) => {
    const root = mkdtempSync(join(tmpdir(), "docker-mirror-wait-"));
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "system")); mkdirSync(join(root, ".matrix-home-mirror"));
      writeFileSync(join(root, "system/soul.md"), "owner customized soul");
      const hash = `sha256:${createHash("sha256").update("owner customized soul").digest("hex")}`;
      writeFileSync(join(root, ".matrix-home-mirror/state.json"), JSON.stringify({ hashes: { "system/soul.md": matching ? hash : "old hash" }, conflicts: {} }));
      writeFileSync(join(root, "bin/docker"), '#!/bin/sh\nshift 6\nexec "$@"\n'); chmodSync(join(root, "bin/docker"), 0o755);
      writeFileSync(join(root, "bin/sleep"), '#!/bin/sh\nexit 0\n'); chmodSync(join(root, "bin/sleep"), 0o755);
      const result = spawnSync("bash", ["-c", 'source "$1"; wait_for_mirror_hash dev system/soul.md 2', "fixture", join(process.cwd(), "scripts/docker-test/lib.sh")], {
        env: { ...process.env, MATRIX_HOME: root, PATH: `${join(root, "bin")}:${process.env.PATH}` }, encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).toBe(matching ? 0 : 1);
      expect(result.stdout).toContain(matching ? "Mirror accepted current content hash" : "Mirror did not accept current content hash");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("retains preservation/version assertions with mirror enabled in both real scenarios", () => {
    const customized = readFileSync("scripts/docker-test/customized-files.sh", "utf8");
    const upgrade = readFileSync("scripts/docker-test/upgrade.sh", "utf8");
    expect(customized).toContain('"customized soul" "soul.md still has custom content after sync"');
    expect(upgrade).toContain('".matrix-version updated to current version"');
    for (const script of [customized, upgrade]) {
      expect(script).toContain('wait_for_mirror_hash "dev" "system/soul.md"');
      expect(script).not.toContain("MATRIX_HOME_MIRROR=false");
    }
  });
});
