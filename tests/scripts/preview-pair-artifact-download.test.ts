import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadPreviewPairArtifact } from "../../scripts/preview-pair/artifact-download.js";

describe("authenticated preview artifact download", () => {
  let parent: string;
  beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), "preview-artifact-test-")); });
  afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
  function setup(archive = zipSync({ "image.tar": strToU8("opaque candidate image bytes") })) {
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const expected = { artifactId: 100, runId: 42, artifactName: "preview-pair-platform-test", sha256, sizeBytes: archive.length };
    const metadata = { id: 100, name: expected.artifactName, workflow_run: { id: 42 }, expired: false,
      digest: `sha256:${sha256}`, size_in_bytes: archive.length };
    const options = { payload: archive, location: "https://productionresultssa8.blob.core.windows.net/fixture/archive.zip" };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.origin === "https://api.github.com") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-fixture-token");
        if (url.pathname.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: options.location } });
        return Response.json(metadata);
      }
      expect(url.origin).toBe("https://productionresultssa8.blob.core.windows.net");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      return new Response(options.payload);
    });
    const download = (allowFile = (name: string) => name === "image.tar") => downloadPreviewPairArtifact({
      expected, token: "private-fixture-token", fetchImpl, allowFile, temporaryParent: parent });
    return { download, expected, metadata, options, fetchImpl };
  }
  it("verifies immutable archive bytes and writes only an owned disposable directory", async () => {
    const s = setup(), result = await s.download();
    try {
      expect(await readFile(join(result.directory, "image.tar"), "utf8")).toBe("opaque candidate image bytes");
      expect(result.files).toEqual(["image.tar"]);
      expect(s.fetchImpl).toHaveBeenCalledTimes(3);
    } finally { await result.dispose(); }
    expect(await readdir(parent)).toEqual([]);
  });
  it("accepts ZIP64 produced by an independent standard-library archive writer", async () => {
    const archive = execFileSync("python3", ["-c", [
      "import io,sys,zipfile", "zipfile.ZIP64_LIMIT=0", "out=io.BytesIO()",
      "with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as archive:",
      " with archive.open('image.tar','w',force_zip64=True) as target:", "  target.write(b'opaque candidate image bytes')",
      "sys.stdout.buffer.write(out.getvalue())",
    ].join("\n")], { maxBuffer: 16 * 1024, timeout: 10_000 });
    const result = await setup(archive).download();
    try { expect(await readFile(join(result.directory, "image.tar"), "utf8")).toBe("opaque candidate image bytes"); }
    finally { await result.dispose(); }
  });
  it.each(["run", "name", "digest", "size", "expired"])("rejects %s metadata before following any archive redirect", async fault => {
    const s = setup();
    if (fault === "run") s.metadata.workflow_run.id = 99;
    if (fault === "name") s.metadata.name = "another-artifact";
    if (fault === "digest") s.metadata.digest = `sha256:${"e".repeat(64)}`;
    if (fault === "size") s.metadata.size_in_bytes++;
    if (fault === "expired") s.metadata.expired = true;
    await expect(s.download()).rejects.toThrow("unavailable");
    expect(s.fetchImpl).toHaveBeenCalledTimes(1); expect(await readdir(parent)).toEqual([]);
  });
  it.each(["../outside", "/outside", "objects/../outside", "unexpected\nname"])("rejects unsafe archive path %s even with a permissive caller", async name => {
    const s = setup(zipSync({ [name]: strToU8("must not escape") }));
    await expect(s.download(() => true)).rejects.toThrow("unavailable");
    expect(await readdir(parent)).toEqual([]);
  });
  it("rejects a foreign signed-storage redirect without sending it a bearer", async () => {
    const s = setup(); s.options.location = "https://attacker.invalid/archive.zip";
    await expect(s.download()).rejects.toThrow("unavailable");
    expect(s.fetchImpl).toHaveBeenCalledTimes(2); expect(await readdir(parent)).toEqual([]);
  });
  it("removes quarantined output when the downloaded digest differs", async () => {
    const s = setup(zipSync({ "image.tar": strToU8("opaque candidate image bytes") }, { level: 0 }));
    s.options.payload = zipSync({ "image.tar": strToU8("opaque candidate IMAGE bytes") }, { level: 0 });
    expect(s.options.payload.length).toBe(s.expected.sizeBytes);
    await expect(s.download()).rejects.toThrow("unavailable"); expect(await readdir(parent)).toEqual([]);
  });
  it("rejects a truncated archive even when its expected checksum matches the truncated bytes", async () => {
    const archive = zipSync({ "image.tar": strToU8("opaque image") });
    const s = setup(archive.subarray(0, archive.length - 22));
    await expect(s.download()).rejects.toThrow("unavailable"); expect(await readdir(parent)).toEqual([]);
  });
});
