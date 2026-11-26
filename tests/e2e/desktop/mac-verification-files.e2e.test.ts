import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyFilesInElectron } from "./fixtures/mac-verification-files.mjs";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Mac verification Files E2E requires bun run build:desktop");
}

describe.runIf(existsSync(main))("Mac verification in built Electron Desktop Files", () => {
  it("moves one disposable file to real Gateway Trash and restores its original bytes with Undo", async () => {
    const temp = await mkdtemp(join(await realpath(tmpdir()), "matrix-files-verification-e2e-"));
    try {
      const profile = join(temp, "profile");
      const png = join(temp, "files.png");
      await mkdir(profile, { mode: 0o700 });
      await verifyFilesInElectron({
        root, profile, png, menuLabel: "Move to Trash", listingDelayMs: 250,
        electronPath: process.env.MATRIX_DESKTOP_E2E_ELECTRON_PATH ?? desktopRequire("electron") as string,
      });
      const evidence = await readFile(png);
      expect(evidence.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(evidence.readUInt32BE(16)).toBeGreaterThanOrEqual(1000);
      expect(evidence.readUInt32BE(20)).toBeGreaterThanOrEqual(600);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 90_000);
});
