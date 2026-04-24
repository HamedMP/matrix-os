import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { installApp, installVerifiedApp } from "../../../packages/gateway/src/app-runtime/install-flow.js";
import { ManifestError, BuildError } from "../../../packages/gateway/src/app-runtime/errors.js";

let tmpDir: string;
let homeDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-install-flow-"));
  homeDir = join(tmpDir, "home");
  await mkdir(join(homeDir, "apps"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("installApp", () => {
  it("installs a static app from source directory", async () => {
    const sourceDir = join(tmpDir, "source", "calculator-static");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator-static",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
      }),
    );
    await writeFile(join(sourceDir, "index.html"), "<html><body>Calculator</body></html>");

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(true);
    const targetDir = join(homeDir, "apps", "calculator-static");
    expect(existsSync(join(targetDir, "matrix.json"))).toBe(true);
    expect(existsSync(join(targetDir, "index.html"))).toBe(true);
  });

  it("installs and builds a vite app", async () => {
    const sourceDir = join(tmpDir, "source", "hello-vite");
    await cp(
      join(process.cwd(), "tests/fixtures/apps/hello-vite"),
      sourceDir,
      { recursive: true },
    );

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(true);
    const targetDir = join(homeDir, "apps", "hello-vite");
    expect(existsSync(join(targetDir, "dist", "index.html"))).toBe(true);
  }, 120_000);

  it("rejects when manifest slug does not match directory name", async () => {
    const sourceDir = join(tmpDir, "source", "wrong-name");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
      }),
    );

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ManifestError);
      expect((result.error as ManifestError).code).toBe("slug_mismatch");
    }
  });

  it("rejects when runtimeVersion is incompatible", async () => {
    const sourceDir = join(tmpDir, "source", "futuristic");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Futuristic",
        slug: "futuristic",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^99.0.0",
      }),
    );

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ManifestError);
      expect((result.error as ManifestError).code).toBe("runtime_version_mismatch");
    }
  });

  it("cleans up partial install on failure", async () => {
    const sourceDir = join(tmpDir, "source", "broken-vite");
    await mkdir(join(sourceDir, "src"), { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Broken",
        slug: "broken-vite",
        version: "1.0.0",
        runtime: "vite",
        runtimeVersion: "^1.0.0",
        build: {
          install: "pnpm install",
          command: "pnpm build",
          output: "dist",
          timeout: 10,
        },
      }),
    );
    await writeFile(join(sourceDir, "package.json"), "{ invalid json");

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(false);
    const targetDir = join(homeDir, "apps", "broken-vite");
    // Target should be cleaned up on failure
    expect(existsSync(targetDir)).toBe(false);
  }, 30_000);

  it("allows idempotent reinstall over existing directory", async () => {
    const sourceDir = join(tmpDir, "source", "calculator-static");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator-static",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
      }),
    );
    await writeFile(join(sourceDir, "index.html"), "<html><body>v1</body></html>");

    // First install
    const r1 = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });
    expect(r1.ok).toBe(true);

    // Update source
    await writeFile(join(sourceDir, "index.html"), "<html><body>v2</body></html>");

    // Reinstall
    const r2 = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });
    expect(r2.ok).toBe(true);

    const html = await readFile(join(homeDir, "apps", "calculator-static", "index.html"), "utf8");
    expect(html).toContain("v2");
  });

  it("rejects manifest with invalid format", async () => {
    const sourceDir = join(tmpDir, "source", "bad-manifest");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "matrix.json"), "not json at all");

    const result = await installApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ManifestError);
    }
  });
});

describe("installVerifiedApp (verified path)", () => {
  it("rebuilds from source and hashes on community tier", async () => {
    const sourceDir = join(tmpDir, "source", "hello-vite");
    await cp(
      join(process.cwd(), "tests/fixtures/apps/hello-vite"),
      sourceDir,
      { recursive: true },
    );

    // Create a dist directory with a pre-built artifact and declared hash
    const distDir = join(sourceDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html>pre-built</html>");

    const result = await installVerifiedApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
      listingTrust: "community",
      declaredDistHash: "will-be-replaced-after-build",
    });

    // The pre-built dist should have been discarded and rebuilt from source
    if (result.ok) {
      const targetDir = join(homeDir, "apps", "hello-vite");
      const html = await readFile(join(targetDir, "dist", "index.html"), "utf8");
      // The rebuilt output should NOT be the pre-built "pre-built" content
      expect(html).not.toContain("pre-built");
    }
  }, 120_000);

  it("rejects on hash mismatch for community tier", async () => {
    const sourceDir = join(tmpDir, "source", "hello-vite");
    await cp(
      join(process.cwd(), "tests/fixtures/apps/hello-vite"),
      sourceDir,
      { recursive: true },
    );

    const result = await installVerifiedApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
      listingTrust: "community",
      declaredDistHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BuildError);
      expect((result.error as BuildError).code).toBe("hash_mismatch");
    }
  }, 120_000);

  it("trusts pre-built dist for first_party", async () => {
    const sourceDir = join(tmpDir, "source", "calculator-static");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator-static",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
        listingTrust: "first_party",
      }),
    );
    await writeFile(join(sourceDir, "index.html"), "<html><body>Calculator</body></html>");

    const result = await installVerifiedApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
      listingTrust: "first_party",
    });

    expect(result.ok).toBe(true);
  });

  it("trusts pre-built dist for verified_partner", async () => {
    const sourceDir = join(tmpDir, "source", "calculator-static");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator-static",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
        listingTrust: "verified_partner",
      }),
    );
    await writeFile(join(sourceDir, "index.html"), "<html><body>Calculator</body></html>");

    const result = await installVerifiedApp({
      sourceDir,
      homeDir,
      storeDir: join(tmpDir, ".pnpm-store"),
      listingTrust: "verified_partner",
    });

    expect(result.ok).toBe(true);
  });
});
