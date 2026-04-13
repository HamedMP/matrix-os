import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashFile } from "../../src/lib/hash.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-hash-test");

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("returns sha256: prefix followed by 64-char lowercase hex", async () => {
    const filePath = join(TEST_DIR, "hello.txt");
    await writeFile(filePath, "hello world");

    const hash = await hashFile(filePath);

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces consistent hash for identical content", async () => {
    const file1 = join(TEST_DIR, "a.txt");
    const file2 = join(TEST_DIR, "b.txt");
    await writeFile(file1, "same content");
    await writeFile(file2, "same content");

    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);

    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different content", async () => {
    const file1 = join(TEST_DIR, "x.txt");
    const file2 = join(TEST_DIR, "y.txt");
    await writeFile(file1, "content A");
    await writeFile(file2, "content B");

    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);

    expect(hash1).not.toBe(hash2);
  });

  it("matches Node.js crypto SHA-256 for known content", async () => {
    const content = "test file content for verification";
    const filePath = join(TEST_DIR, "verify.txt");
    await writeFile(filePath, content);

    const expected =
      "sha256:" +
      createHash("sha256").update(content).digest("hex");

    const hash = await hashFile(filePath);

    expect(hash).toBe(expected);
  });

  it("handles empty files", async () => {
    const filePath = join(TEST_DIR, "empty.txt");
    await writeFile(filePath, "");

    const hash = await hashFile(filePath);

    const expected =
      "sha256:" + createHash("sha256").update("").digest("hex");
    expect(hash).toBe(expected);
  });

  it("throws a typed error for missing files", async () => {
    const filePath = join(TEST_DIR, "nonexistent.txt");

    const err = await hashFile(filePath).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
