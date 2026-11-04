import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extractPreviewDesktop } from "../../scripts/preview-pair/desktop-archive.js";
let parent: string;
beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), "eng418-inner-tar-")); });
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
async function archive(entries: Array<{ path: string; type?: string; link?: string; mode?: number; text?: string }>) {
  // Independent producer, including BSD/PAX names and framework symlinks.
  const bytes = execFileSync("python3", ["-c", `import tarfile,io,json,sys
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz',format=tarfile.PAX_FORMAT) as tar:
 for e in json.loads(sys.argv[1]):
  item=tarfile.TarInfo(e['path']); item.mode=e.get('mode',0o755)
  kind=e.get('type','file')
  if kind=='symlink': item.type=tarfile.SYMTYPE; item.linkname=e['link']
  elif kind=='hardlink': item.type=tarfile.LNKTYPE; item.linkname=e['link']
  elif kind=='directory': item.type=tarfile.DIRTYPE
  elif kind=='fifo': item.type=tarfile.FIFOTYPE
  else: data=e.get('text','binary fixture').encode(); item.size=len(data)
  tar.addfile(item,io.BytesIO(data) if kind=='file' else None)
sys.stdout.buffer.write(out.getvalue())`, JSON.stringify(entries)], { timeout: 10_000, maxBuffer: 1_000_000 });
  const file = join(parent, "candidate.tar.gz"); await writeFile(file, bytes); return file;
}
it("extracts the actual portable Linux layout including leading ./ and strips privileged mode bits", async () => {
  const file = await archive([{ path: "./", type: "directory" }, { path: "./desktop", mode: 0o6755, text: "opaque executable" }]);
  const app = await extractPreviewDesktop(file, "desktop", parent);
  expect(await readFile(app.executable, "utf8")).toBe("opaque executable");
  expect((await stat(app.executable)).mode & 0o7000).toBe(0);
  await app.dispose(); expect(await readdir(parent)).toEqual(["candidate.tar.gz"]);
});
it.each([false, true])("preserves macOS framework links with a symlinked temporary parent=%s", async aliased => {
  const file = await archive([{ path: "Matrix OS.app/Contents/MacOS/Matrix OS" },
    { path: "Matrix OS.app/Contents/Frameworks/Framework/Versions/A/Resources/a", text: "framework" },
    { path: "Matrix OS.app/Contents/Frameworks/Framework/Versions/Current", type: "symlink", link: "A" },
    { path: "Matrix OS.app/Contents/Frameworks/Framework/Resources", type: "symlink", link: "Versions/Current/Resources" }]);
  const selectedParent = aliased ? join(parent, "temporary-parent-alias") : parent;
  if (aliased) await symlink(parent, selectedParent);
  const app = await extractPreviewDesktop(file, "Matrix OS.app/Contents/MacOS/Matrix OS", selectedParent);
  expect(await readFile(join(app.directory, "Matrix OS.app/Contents/Frameworks/Framework/Resources/a"), "utf8")).toBe("framework");
  await app.dispose();
});
it.each([
  [{ path: "../escape" }], [{ path: "/absolute" }], [{ path: "a", type: "symlink", link: "../../escape" }],
  [{ path: "a", type: "symlink", link: "/tmp/escape" }], [{ path: "desktop", type: "hardlink", link: "elsewhere" }],
  [{ path: "a", type: "fifo" }], [{ path: "desktop" }, { path: "desktop" }],
  [{ path: "a", type: "symlink", link: "b" }, { path: "a/desktop" }],
].map(entries => [entries]))("rejects unsafe entries before leaving an extracted app: %j", async entries => {
  const file = await archive(entries); await expect(extractPreviewDesktop(file, "desktop", parent)).rejects.toThrow("unavailable");
  expect(await readdir(parent)).toEqual(["candidate.tar.gz"]);
});
it("rejects a missing or non-executable entry rather than using an installed Matrix app", async () => {
  const file = await archive([{ path: "desktop", mode: 0o644 }]);
  await expect(extractPreviewDesktop(file, "desktop", parent)).rejects.toThrow("unavailable");
});
