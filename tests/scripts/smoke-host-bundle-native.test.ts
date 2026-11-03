import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/smoke-host-bundle-native.mjs");
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(kind: string) {
  const work = await mkdtemp(join(tmpdir(), "matrix-native-smoke-test-")); temporary.push(work);
  const archive = join(work, "bundle.tar.gz");
  execFileSync("python3", ["-c", `
import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    kind=sys.argv[2]
    name={'traversal':'../outside','absolute':'/tmp/matrix-native-escape','backslash':'app'+chr(92)+'escape','nul':'app'+chr(0)+'escape','link':'app/node_modules/escape','hardlink':'app/node_modules/escape','internal-link':'app/node_modules/package','special':'app/node_modules/pipe','setgid-directory':'runtime/node/bin','setgid-file':'runtime/node/bin/node','setuid-directory':'runtime/node/bin','sticky-directory':'runtime/node/bin','missing':'release.json'}[kind]
    item=tarfile.TarInfo(name)
    if kind=='nul': item.pax_headers={'path':name}
    if kind in ('setgid-directory','setuid-directory','sticky-directory'):
        item.type=tarfile.DIRTYPE
        item.mode={'setgid-directory':0o2775,'setuid-directory':0o4775,'sticky-directory':0o1775}[kind]
        archive.addfile(item)
    elif kind=='special':
        item.type=tarfile.FIFOTYPE
        archive.addfile(item)
    elif kind in ('link','hardlink','internal-link'):
        item.type=tarfile.SYMTYPE if kind=='link' else tarfile.LNKTYPE
        if kind=='internal-link': item.type=tarfile.SYMTYPE
        item.linkname='../packages/package' if kind=='internal-link' else '../../../outside'
        archive.addfile(item)
    else:
        contents=b'{}'
        if kind=='setgid-file': item.mode=0o2755
        item.size=len(contents)
        archive.addfile(item,io.BytesIO(contents))
`, archive, kind], { timeout: 10_000 });
  return { work, archive };
}

describe("final host artifact native smoke orchestration (not native qualification)", () => {
  it.each(["traversal", "absolute", "backslash", "nul", "link", "hardlink", "special", "setgid-file", "setuid-directory", "sticky-directory"])("refuses %s archive entries before running payload code and removes owned extraction", async (kind) => {
    const { work, archive } = await fixture(kind);
    const result = spawnSync(process.execPath, [script, archive], {
      env: { PATH: process.env.PATH, HOME: work, TMPDIR: work }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"code":"artifact_archive_rejected"');
    expect(await readdir(work)).toEqual(["bundle.tar.gz"]);
  });

  it("accepts bundled runtime setgid directories, then refuses missing payload", async () => {
    const { work, archive } = await fixture("setgid-directory");
    const result = spawnSync(process.execPath, [script, archive], {
      env: { PATH: process.env.PATH, HOME: work, TMPDIR: work }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"code":"artifact_payload_incomplete"');
    expect(await readdir(work)).toEqual(["bundle.tar.gz"]);
  });

  it("accepts an internal workspace link at extraction, then refuses missing payload", async () => {
    const { work, archive } = await fixture("internal-link");
    const result = spawnSync(process.execPath, [script, archive], {
      env: { PATH: process.env.PATH, HOME: work, TMPDIR: work }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"code":"artifact_payload_incomplete"');
    expect(await readdir(work)).toEqual(["bundle.tar.gz"]);
  });

  it("fails an incomplete artifact instead of claiming native success, and cleans extraction", async () => {
    const { work, archive } = await fixture("missing");
    const result = spawnSync(process.execPath, [script, archive], {
      env: { PATH: process.env.PATH, HOME: work, TMPDIR: work }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code":"artifact_payload_incomplete"');
    expect(await readdir(work)).toEqual(["bundle.tar.gz"]);
  });
});
