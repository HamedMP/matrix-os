import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBudgets } from "../../scripts/review/check-budgets.mjs";

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-budgets-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, { flag: "wx" });
  }
  return root;
}

describe("checkBudgets", () => {
  it("passes on a clean tree under all budgets", async () => {
    const root = await fixture({ "packages/a/src/ok.ts": lines(100) });
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 500, ratchets: {}, dirCaps: {}, allowlist: {} },
      });
      expect(result.violations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags a ratchet file that grew past its recorded max", async () => {
    const root = await fixture({ "packages/gateway/src/server.ts": lines(4800) });
    try {
      const result = await checkBudgets({
        root,
        config: {
          fileCap: 500,
          ratchets: { "packages/gateway/src/server.ts": 4769 },
          dirCaps: {},
          allowlist: { "packages/gateway/src/server.ts": { issue: "#1676", note: "Phase 1" } },
        },
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: "ratchet",
        path: "packages/gateway/src/server.ts",
        actual: 4800,
        max: 4769,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags a new god file that is not on the allowlist", async () => {
    const root = await fixture({ "packages/x/src/new-god.ts": lines(1200) });
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 1000, ratchets: {}, dirCaps: {}, allowlist: {} },
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({ kind: "file-cap", path: "packages/x/src/new-god.ts" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns (not violates) for allowlisted debt under its ratchet", async () => {
    const root = await fixture({ "packages/x/src/known-god.ts": lines(1100) });
    try {
      const result = await checkBudgets({
        root,
        config: {
          fileCap: 1000,
          ratchets: { "packages/x/src/known-god.ts": 1200 },
          dirCaps: {},
          allowlist: { "packages/x/src/known-god.ts": { issue: "#1676", note: "tracked" } },
        },
      });
      expect(result.violations).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ kind: "allowlisted", path: "packages/x/src/known-god.ts" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags a flat directory that grew past its cap", async () => {
    const root = await fixture({
      "packages/gateway/src/a.ts": lines(10),
      "packages/gateway/src/b.ts": lines(10),
      "packages/gateway/src/c.ts": lines(10),
    });
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 1000, ratchets: {}, dirCaps: { "packages/gateway/src": 2 }, allowlist: {} },
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: "dir-cap",
        path: "packages/gateway/src",
        actual: 3,
        max: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores tests, type declarations, and nested files in dir caps", async () => {
    const root = await fixture({
      "packages/gateway/src/a.ts": lines(10),
      "packages/gateway/src/a.test.ts": lines(2000),
      "packages/gateway/src/types.d.ts": lines(2000),
      "packages/gateway/src/nested/b.ts": lines(10),
    });
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 1000, ratchets: {}, dirCaps: { "packages/gateway/src": 1 }, allowlist: {} },
      });
      expect(result.violations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal-capable root and config paths", async () => {
    await expect(checkBudgets({ root: "/tmp/../etc", config: { fileCap: 1, ratchets: {}, dirCaps: {}, allowlist: {} } })).rejects.toThrow();
  });

  it("rejects allowlist entries without a linked issue and phase note", async () => {
    const root = await fixture({ "packages/a/src/ok.ts": lines(10) });
    try {
      const base = { fileCap: 1000, ratchets: {}, dirCaps: {} };
      await expect(
        checkBudgets({ root, config: { ...base, allowlist: { "x.ts": { issue: "", note: "Phase 1" } } } }),
      ).rejects.toThrow(/allowlist/);
      await expect(
        checkBudgets({ root, config: { ...base, allowlist: { "x.ts": { issue: "#1676" } } } }),
      ).rejects.toThrow(/allowlist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps reported findings so memory stays bounded on huge trees", async () => {
    const files = {};
    for (let i = 0; i < 105; i += 1) {
      files[`packages/a/src/f${i}.ts`] = lines(5);
    }
    const root = await fixture(files);
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 1, ratchets: {}, dirCaps: {}, allowlist: {} },
      });
      expect(result.violations).toHaveLength(100);
      expect(result.suppressed.violations).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a root that is not a directory", async () => {
    const root = await fixture({ "packages/a/src/ok.ts": lines(10) });
    try {
      await expect(
        checkBudgets({
          root: join(root, "packages/a/src/ok.ts"),
          config: { fileCap: 1000, ratchets: {}, dirCaps: {}, allowlist: {} },
        }),
      ).rejects.toThrow(/not a directory/);
      await expect(
        checkBudgets({
          root: join(root, "does-not-exist"),
          config: { fileCap: 1000, ratchets: {}, dirCaps: {}, allowlist: {} },
        }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips fixture data directories", async () => {
    const root = await fixture({
      "tests/e2e/fixtures/stub.ts": lines(2000),
      "packages/a/src/real.ts": lines(100),
    });
    try {
      const result = await checkBudgets({
        root,
        config: { fileCap: 1000, ratchets: {}, dirCaps: {}, allowlist: {} },
      });
      expect(result.violations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
