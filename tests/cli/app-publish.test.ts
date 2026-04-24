import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { publishApp, type PublishResult } from "../../packages/cli/src/commands/app-publish.js";

let tmpDir: string;
let storeDir: string;
let prevPublishKey: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-publish-"));
  storeDir = join(tmpDir, "store");
  await mkdir(storeDir, { recursive: true });
  prevPublishKey = process.env.MATRIX_PUBLISH_KEY;
  process.env.MATRIX_PUBLISH_KEY =
    "test-publish-key-0000000000000000000000000000000000";
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (prevPublishKey === undefined) {
    delete process.env.MATRIX_PUBLISH_KEY;
  } else {
    process.env.MATRIX_PUBLISH_KEY = prevPublishKey;
  }
});

describe("publishApp", () => {
  async function createStaticFixture(slug: string): Promise<string> {
    const appDir = join(tmpDir, slug);
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "matrix.json"),
      JSON.stringify({
        name: "Test App",
        slug,
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
      }),
    );
    await writeFile(join(appDir, "index.html"), "<html><body>Hello</body></html>");
    return appDir;
  }

  async function createViteFixture(slug: string): Promise<string> {
    const appDir = join(tmpDir, slug);
    await mkdir(join(appDir, "src"), { recursive: true });
    await mkdir(join(appDir, "dist"), { recursive: true });
    await writeFile(
      join(appDir, "matrix.json"),
      JSON.stringify({
        name: "Vite App",
        slug,
        version: "1.0.0",
        runtime: "vite",
        runtimeVersion: "^1.0.0",
        build: {
          install: "echo install",
          command: "echo build",
          output: "dist",
          timeout: 10,
        },
      }),
    );
    await mkdir(join(appDir, "dist/assets"), { recursive: true });
    await writeFile(join(appDir, "package.json"), JSON.stringify({ name: slug, version: "1.0.0" }));
    await writeFile(join(appDir, "src/main.tsx"), "export default function App() { return <div>Hello</div>; }");
    await writeFile(join(appDir, "dist/index.html"), "<html><body>Built</body></html>");
    await writeFile(join(appDir, "dist/assets/main.js"), "console.log('hello');");
    return appDir;
  }

  it("validates manifest before publishing", async () => {
    const appDir = join(tmpDir, "bad-manifest");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), "not valid json");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
  });

  it("rejects manifest missing required fields", async () => {
    const appDir = join(tmpDir, "missing-fields");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), JSON.stringify({ name: "Test" }));

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(false);
  });

  it("creates a source tarball", async () => {
    const appDir = await createStaticFixture("tar-source-test");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(result.artifacts.sourceTar)).toBe(true);
      const stats = await stat(result.artifacts.sourceTar);
      expect(stats.size).toBeGreaterThan(0);
    }
  });

  it("creates a dist tarball for vite apps", async () => {
    const appDir = await createViteFixture("tar-dist-test");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts.distTar).toBeDefined();
      expect(existsSync(result.artifacts.distTar!)).toBe(true);
    }
  });

  it("computes dist hash for integrity verification", async () => {
    const appDir = await createViteFixture("hash-dist-test");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts.distHash).toBeDefined();
      expect(typeof result.artifacts.distHash).toBe("string");
      expect(result.artifacts.distHash!.length).toBe(64); // sha256 hex
    }
  });

  it("signs the bundle", async () => {
    const appDir = await createStaticFixture("sign-bundle-test");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts.signature).toBeDefined();
      expect(typeof result.artifacts.signature).toBe("string");
      expect(result.artifacts.signature.length).toBeGreaterThan(0);
    }
  });

  it("writes bundle to local store directory (upload stub)", async () => {
    const appDir = await createStaticFixture("upload-stub-test");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify the bundle was written to the store
      const bundlePath = join(storeDir, "upload-stub-test", "1.0.0");
      expect(existsSync(bundlePath)).toBe(true);
    }
  });

  it("includes manifest in the published bundle", async () => {
    const appDir = await createStaticFixture("manifest-in-bundle");

    const result = await publishApp({ appDir, storeDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const manifestPath = join(storeDir, "manifest-in-bundle", "1.0.0", "matrix.json");
      expect(existsSync(manifestPath)).toBe(true);
    }
  });
});
