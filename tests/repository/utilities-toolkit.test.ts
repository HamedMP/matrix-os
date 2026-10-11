import { describe, expect, it } from "vitest";
import { adaptToolkitSource, verifySnapshot } from "../../scripts/utility-toolkit-snapshot.mjs";
import { refreshUtilitiesBuildInputs } from "../../scripts/utilities-build-inputs.mjs";
import { hashSources } from "../../packages/gateway/src/app-runtime/build-cache";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { toolIconSvg } from "../../home/apps/utilities/src/vendor/lib/tool-icons.mjs";

describe("pinned Utilities toolkit", () => {
  it("verifies every shipped toolkit file against its committed source manifest", async () => {
    const app = new URL("../../home/apps/utilities/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("toolkit-source.json", app), "utf8"));
    expect(manifest.dirty).toBe(false);
    expect(manifest.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(await verifySnapshot(app.pathname, manifest)).toEqual([]);
  });
  it("ships the same illustrated Utilities artwork in the launcher and app", async () => {
    const icon = await readFile(new URL("../../home/system/icons/utilities.svg", import.meta.url), "utf8");
    expect(icon.trim()).toBe(toolIconSvg("utilities"));
  });
  it("does not ship model assets for website-only tools", async () => {
    const app = new URL("../../home/apps/utilities/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("toolkit-source.json", app), "utf8"));
    expect(manifest.files.filter((file: { path: string }) => file.path.startsWith("public/tools/models/"))).toEqual([]);
    await expect(stat(new URL("public/tools/models", app))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs functional engines without copying website model assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "utilities-sync-test-"));
    const site = join(root, "site");
    const app = join(root, "home/apps/utilities");
    try {
      await Promise.all([
        mkdir(join(root, "scripts"), { recursive: true }),
        mkdir(join(site, "src/lib/free-tools"), { recursive: true }),
        mkdir(join(site, "src/app/tools"), { recursive: true }),
        mkdir(join(site, "public/tools/models/mediapipe"), { recursive: true }),
      ]);
      await Promise.all([
        cp(new URL("../../scripts/sync-utilities-toolkit.mjs", import.meta.url), join(root, "scripts/sync-utilities-toolkit.mjs")),
        cp(new URL("../../scripts/utility-toolkit-snapshot.mjs", import.meta.url), join(root, "scripts/utility-toolkit-snapshot.mjs")),
        writeFile(join(site, "src/lib/free-tools/tool-icons.mjs"), 'export const toolIconSvg = () => "<svg/>";'),
        writeFile(join(site, "src/lib/free-tools/engine.mjs"), "export const runTool = () => 42;"),
        writeFile(join(site, "public/tools/models/mediapipe/model.wasm"), "unused model fixture"),
      ]);
      const git = (...args: string[]) => execFileSync("git", ["-C", site, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet");
      git("add", ".");
      git("-c", "user.name=Utilities test", "-c", "user.email=utilities@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
      execFileSync(process.execPath, [join(root, "scripts/sync-utilities-toolkit.mjs"), site]);
      expect(await readFile(join(app, "src/vendor/lib/engine.mjs"), "utf8")).toBe("export const runTool = () => 42;");
      const manifest = JSON.parse(await readFile(join(app, "toolkit-source.json"), "utf8"));
      expect(manifest.revision).toBe(git("rev-parse", "HEAD"));
      expect(manifest.dirty).toBe(false);
      expect(manifest.files.some((file: { path: string }) => file.path.startsWith("public/"))).toBe(false);
      await expect(stat(join(app, "public/tools/models"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await verifySnapshot(app, manifest)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("adapts website aliases without embedding website navigation or analytics", () => {
    const source = 'import { runTool } from "@/lib/free-tools/engine.mjs";\nimport { palette } from "@/components/landing/theme";\nimport { capturePostHogEvent } from "@/lib/posthog-client";';
    const result = adaptToolkitSource("src/app/tools/ToolWorkspace.tsx", source);
    expect(result).toContain('"../lib/engine.mjs"');
    expect(result).toContain('"@matrix-os/brand"');
    expect(result).toContain('"../runtime/telemetry"');
    expect(result).not.toContain('"@/');
  });

  it("resolves face assets under the installed app rather than the website root", () => {
    const result = adaptToolkitSource("src/lib/free-tools/image-tools.mjs", 'const FACE_MODEL = "/tools/models/mediapipe/face.tflite";');
    expect(result).toContain('new URL("./tools/models/mediapipe/face.tflite", document.baseURI).href');
  });

  it("replaces audio recovery with an explicit ephemeral app adapter", () => {
    const result = adaptToolkitSource("src/lib/free-tools/audio-session.mjs", "indexedDB.open('site-data')");
    expect(result).not.toContain("indexedDB");
    expect(result).toContain("current Utilities window");
    expect(result).toContain("readAudioSession");
    expect(result).toContain('Promise<ReturnType<typeof import("./audio-tools.mjs").normalizeAudioSessionManifest>');
    expect(result).toContain('@param {string} id');
  });

  it("fails verification on changed generated source", async () => {
    const root = await mkdtemp(join(tmpdir(), "utilities-snapshot-test-"));
    try {
      await mkdir(join(root, "src/vendor/lib"), { recursive: true });
      const content = "export const value = 1;";
      await writeFile(join(root, "src/vendor/lib/test.mjs"), content);
      const files = [{ path: "src/vendor/lib/test.mjs", sha256: createHash("sha256").update(content).digest("hex") }];
      expect(await verifySnapshot(root, { files })).toEqual([]);
      await writeFile(join(root, "src/vendor/lib/test.mjs"), "changed");
      expect(await verifySnapshot(root, { files })).toEqual(["src/vendor/lib/test.mjs"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Utilities build input fingerprints", () => {
  async function withFixture(run: (root: string, app: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "utilities-build-inputs-"));
    const app = join(root, "home/apps/utilities");
    try {
      await Promise.all([
        mkdir(join(root, "scripts"), { recursive: true }),
        mkdir(join(root, "packages/utilities-runtime"), { recursive: true }),
        mkdir(join(root, "packages/brand/src"), { recursive: true }),
        mkdir(join(app, "src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "scripts/build-utilities-app.mjs"), "export const build = 1;"),
        writeFile(join(root, "packages/utilities-runtime/package.json"), '{"dependencies":{"vite":"6.4.2"}}'),
        writeFile(join(root, "packages/brand/src/tokens.ts"), 'export const color = "green";'),
        writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
        writeFile(join(app, "src/main.tsx"), "export const App = () => null;"),
        writeFile(join(app, "matrix.json"), await readFile(new URL("../../home/apps/utilities/matrix.json", import.meta.url))),
      ]);
      await run(root, app);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it.each([
    ["packages/brand/src/tokens.ts", 'export const color = "blue";'],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\nsettings: {}\n"],
    ["packages/utilities-runtime/package.json", '{"dependencies":{"vite":"6.4.3"}}'],
  ])("invalidates the app source hash when %s changes", async (file, content) => {
    await withFixture(async (root, app) => {
      const { build } = JSON.parse(await readFile(join(app, "matrix.json"), "utf8"));
      await refreshUtilitiesBuildInputs(root, app);
      const before = await hashSources(app, build.sourceGlobs);
      const previousInputs = JSON.parse(await readFile(join(app, "build-inputs.json"), "utf8"));
      await writeFile(join(root, file), content);
      await refreshUtilitiesBuildInputs(root, app);
      const inputs = JSON.parse(await readFile(join(app, "build-inputs.json"), "utf8"));
      expect(inputs[file]).not.toBe(previousInputs[file]);
      expect(await hashSources(app, build.sourceGlobs)).not.toBe(before);
    });
  });

  it("does not rewrite unchanged fingerprints or invalidate a current source hash", async () => {
    await withFixture(async (root, app) => {
      const { build } = JSON.parse(await readFile(join(app, "matrix.json"), "utf8"));
      await refreshUtilitiesBuildInputs(root, app);
      const path = join(app, "build-inputs.json");
      const content = await readFile(path, "utf8");
      const sourceHash = await hashSources(app, build.sourceGlobs);
      const timestamp = new Date("2020-01-01T00:00:00Z");
      await utimes(path, timestamp, timestamp);
      await refreshUtilitiesBuildInputs(root, app);
      expect(await readFile(path, "utf8")).toBe(content);
      expect((await stat(path)).mtimeMs).toBe(timestamp.getTime());
      expect(await hashSources(app, build.sourceGlobs)).toBe(sourceHash);
    });
  });

  it("keeps the shipped source hash valid after copying the app into an owner home", async () => {
    await withFixture(async (root, app) => {
      const { build } = JSON.parse(await readFile(join(app, "matrix.json"), "utf8"));
      await refreshUtilitiesBuildInputs(root, app);
      const shippedHash = await hashSources(app, build.sourceGlobs);
      const copiedApp = join(root, "owner/apps/utilities");
      await cp(app, copiedApp, { recursive: true });
      await refreshUtilitiesBuildInputs(root, copiedApp);
      expect(await hashSources(copiedApp, build.sourceGlobs)).toBe(shippedHash);
      const inputs = JSON.parse(await readFile(join(copiedApp, "build-inputs.json"), "utf8"));
      expect(Object.keys(inputs)).toContain("packages/brand/src/tokens.ts");
      expect(Object.keys(inputs).every((path) => !path.startsWith(root))).toBe(true);
      await writeFile(join(copiedApp, "src/main.tsx"), "export const App = () => <main/>;");
      expect(await hashSources(copiedApp, build.sourceGlobs)).not.toBe(shippedHash);
    });
  });
});
