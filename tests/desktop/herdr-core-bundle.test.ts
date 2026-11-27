import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";
import { fetchHerdrCore, herdrCoreTarget, readHerdrCoreManifest } from "../../scripts/release/fetch-herdr-core.mjs";

const root = join(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "herdr-bundle-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** A release archive with the members the real one carries. */
function archive(binary = "#!/bin/sh\necho fake\n") {
  const dir = mkdtempSync(join(scratch, "archive-"));
  writeFileSync(join(dir, "herdr-core"), binary);
  writeFileSync(join(dir, "LICENSE"), "Apache License");
  writeFileSync(join(dir, "THIRD-PARTY-NOTICES"), "notices");
  mkdirSync(join(dir, "Herdr Core.app"));
  writeFileSync(join(dir, "Herdr Core.app/extra"), "not packed");
  execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "herdr-core", "LICENSE", "THIRD-PARTY-NOTICES", "Herdr Core.app"]);
  const bytes = readFileSync(join(dir, "a.tar.gz"));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const manifestFor = (sha256: string) => ({
  version: "0.1.19",
  targets: { "darwin-arm64": { url: "https://releases.herdr.dev/core/0.1.19/herdr-core-macos-aarch64.tar.gz", sha256 } },
});
const serving = (bytes: Buffer, status = 200) => vi.fn(async () => new Response(new Uint8Array(bytes), { status }));

describe("pinned herdr-core", () => {
  it("pins the version the app refuses to deviate from, for every platform the Terminal window ships on", async () => {
    const manifest = await readHerdrCoreManifest();
    expect(manifest.version).toBe(LOCAL_TERMINAL_VERSION);
    expect(Object.keys(manifest.targets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    expect(() => herdrCoreTarget(manifest, "win32", "x64")).toThrow("no pinned herdr-core build");
  });

  it("rejects a manifest that points anywhere but the pinned version on the release host", async () => {
    const write = (targets: unknown, version = "0.1.19") => {
      const path = join(mkdtempSync(join(scratch, "manifest-")), "herdr-core.json");
      writeFileSync(path, JSON.stringify({ version, targets }));
      return path;
    };
    const sha256 = "a".repeat(64);
    for (const url of [
      "https://evil.example/core/0.1.19/herdr-core-macos-aarch64.tar.gz",
      "https://releases.herdr.dev/core/0.1.20/herdr-core-macos-aarch64.tar.gz",
      "https://releases.herdr.dev/core/latest/herdr-core-macos-aarch64.tar.gz",
      "https://releases.herdr.dev/core/0.1.19/x.tar.gz?token=1",
    ]) {
      await expect(readHerdrCoreManifest(write({ "darwin-arm64": { url, sha256 } })), url).rejects.toThrow();
    }
    await expect(readHerdrCoreManifest(write({ "darwin-arm64": { url: "https://releases.herdr.dev/core/0.1.19/a.tar.gz", sha256: "short" } }))).rejects.toThrow("SHA-256");
    await expect(readHerdrCoreManifest(write({}, "latest"))).rejects.toThrow("exact");
  });

  it("unpacks only the binary and its licence texts from an archive that matches its checksum", async () => {
    const { bytes, sha256 } = archive();
    const outDir = join(scratch, "out-ok");
    const fetchImpl = serving(bytes);
    const binary = await fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir, manifest: manifestFor(sha256), fetchImpl });
    expect(binary).toBe(join(outDir, "hc"));
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(outDir, "LICENSE"), "utf8")).toBe("Apache License");
    expect(readFileSync(join(outDir, "VERSION"), "utf8")).toBe("0.1.19\n");
    expect(existsSync(join(outDir, "Herdr Core.app"))).toBe(false);
    // One readable file for Help > Third-Party Notices.
    const notices = readFileSync(join(outDir, "NOTICES.txt"), "utf8");
    expect(notices).toContain("Matrix OS includes herdr-core 0.1.19");
    expect(notices).toContain("Apache License");
    expect(notices).toContain("notices");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://releases.herdr.dev/core/0.1.19/herdr-core-macos-aarch64.tar.gz");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never unpacks an archive whose checksum differs, and leaves no binary behind", async () => {
    const { bytes } = archive();
    const outDir = join(scratch, "out-bad");
    await expect(fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir, manifest: manifestFor("b".repeat(64)), fetchImpl: serving(bytes) }))
      .rejects.toThrow("checksum mismatch");
    expect(existsSync(join(outDir, "hc"))).toBe(false);
    await expect(fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir, manifest: manifestFor("b".repeat(64)), fetchImpl: serving(bytes, 404) }))
      .rejects.toThrow("status 404");
    await expect(fetchHerdrCore({ platform: "linux", arch: "riscv64", outDir, manifest: manifestFor("b".repeat(64)), fetchImpl: serving(bytes) }))
      .rejects.toThrow("no pinned herdr-core build");
  });

  it("stops reading a response that is larger than allowed, before holding it in memory", async () => {
    const outDir = join(scratch, "out-big");
    let pulled = 0;
    let cancelled = false;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    }));
    await expect(fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir, manifest: manifestFor("b".repeat(64)),
      fetchImpl: vi.fn(async () => endless()), maxArchiveBytes: 10 * 1024 })).rejects.toThrow("larger than expected");
    expect(cancelled).toBe(true);
    // It read just past the cap and no further.
    expect(pulled).toBeLessThan(20);

    const declared = vi.fn(async () => new Response(new Uint8Array(8), { headers: { "content-length": String(11 * 1024) } }));
    await expect(fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir, manifest: manifestFor("b".repeat(64)),
      fetchImpl: declared, maxArchiveBytes: 10 * 1024 })).rejects.toThrow("larger than expected");
    expect(existsSync(join(outDir, "hc"))).toBe(false);
  });

  it("refuses an archive member that unpacks larger than allowed, before reading it", async () => {
    // Nine megabytes of zeros compress to a few kilobytes: the download cap alone would not catch it.
    const dir = mkdtempSync(join(scratch, "bomb-"));
    writeFileSync(join(dir, "herdr-core"), "#!/bin/sh\n");
    writeFileSync(join(dir, "LICENSE"), "Apache License");
    writeFileSync(join(dir, "THIRD-PARTY-NOTICES"), Buffer.alloc(9 * 1024 * 1024));
    execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "herdr-core", "LICENSE", "THIRD-PARTY-NOTICES"]);
    const bytes = readFileSync(join(dir, "a.tar.gz"));
    expect(bytes.length).toBeLessThan(1024 * 1024);
    const outDir = join(scratch, "out-bomb");
    await expect(fetchHerdrCore({ platform: "darwin", arch: "arm64", outDir,
      manifest: manifestFor(createHash("sha256").update(bytes).digest("hex")), fetchImpl: serving(bytes) }))
      .rejects.toThrow("THIRD-PARTY-NOTICES is larger than expected");
    expect(existsSync(join(outDir, "NOTICES.txt"))).toBe(false);
  });

  it("is fetched before packaging and packed where the app looks for it, on macOS and Linux only", () => {
    const builder = parse(readFileSync(join(root, "desktop/electron-builder.yml"), "utf8"));
    const packed = [{ from: "build/herdr", to: "herdr" }];
    expect(builder.mac.extraResources).toEqual(packed);
    expect(builder.linux.extraResources).toEqual(packed);
    expect(builder.extraResources).toBeUndefined();
    expect(builder.win.extraResources).toBeUndefined();

    const workflow = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");
    for (const [fetchStep, packageStep] of [
      ["fetch-herdr-core.mjs --platform darwin --arch ${{ matrix.arch }}", '--config "$DESKTOP_BUILDER_CONFIG" --mac --${{ matrix.arch }}'],
      ["fetch-herdr-core.mjs --platform linux --arch x64", '--config "$DESKTOP_BUILDER_CONFIG" --linux AppImage --x64'],
    ] as const) {
      expect(workflow.indexOf(fetchStep), fetchStep).toBeGreaterThan(-1);
      expect(workflow.indexOf(fetchStep)).toBeLessThan(workflow.indexOf(packageStep));
    }
    expect(workflow).toContain('hc_path="$app_path/Contents/Resources/herdr/hc"');
    expect(workflow).toContain('"$app_path/Contents/Resources/herdr/NOTICES.txt"');
    expect(workflow).toContain("desktop/dist/linux-unpacked/resources/herdr/hc --version");
  });
});
