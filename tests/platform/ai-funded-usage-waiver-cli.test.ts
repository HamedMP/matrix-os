import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWaiverArguments, readReviewedWaiver } from "../../scripts/waive-expired-funded-usage.js";

describe("private reviewed waiver CLI", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "matrix-waiver-cli-")); });
  afterEach(async () => { await rm(directory, { force: true, recursive: true }); });
  it("defaults to dry-run and requires an exact review fingerprint to apply", () => {
    expect(parseWaiverArguments(["review.json"])).toEqual({ file: "review.json", apply: false, reviewedFingerprint: undefined });
    expect(parseWaiverArguments(["review.json", "--apply", "--reviewed-sha256", "a".repeat(64)])).toMatchObject({ apply: true });
    for (const arguments_ of [[], ["review.json", "--apply"], ["review.json", "--apply", "--reviewed-sha256", "bad"],
      ["review.json", "--force"], ["review.json", "--apply", "--reviewed-sha256", "a".repeat(64), "extra"]]) {
      expect(() => parseWaiverArguments(arguments_)).toThrow("Usage:");
    }
  });
  it("rejects permissive modes, symlinks, malformed JSON and oversized input", async () => {
    const path = join(directory, "review.json");
    await writeFile(path, "{}", { flag: "wx", mode: 0o644 });
    await expect(readReviewedWaiver(path)).rejects.toThrow("owner-only");
    const link = join(directory, "review-link.json");
    await symlink(path, link);
    await expect(readReviewedWaiver(link)).rejects.toThrow();
    const huge = join(directory, "huge.json");
    await writeFile(huge, " ".repeat(65537), { flag: "wx", mode: 0o600 });
    await expect(readReviewedWaiver(huge)).rejects.toThrow("bounded");
    const bad = join(directory, "bad.json");
    await writeFile(bad, "invalid", { flag: "wx", mode: 0o600 });
    await expect(readReviewedWaiver(bad)).rejects.toThrow();
  });
  it("rejects FIFO reviews without waiting for a writer", async () => {
    const path = join(directory, "review.fifo");
    await promisify(execFile)("mkfifo", ["-m", "600", path]);
    try {
      await promisify(execFile)("bun", ["scripts/waive-expired-funded-usage.ts", path],
        { timeout: 3_000, killSignal: "SIGKILL" });
      throw new Error("A FIFO must not be accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: 1, killed: false });
    }
  });
});
