/**
 * Matrix Core repo archive rules and installer failure modes (spec 2691, layer 6),
 * on real files with hand-built archives at the byte level.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_REPO_MAX_ENTRIES } from "../../packages/contracts/src/core-repo.js";
import { inspectCoreRepoArchive } from "../../packages/sync-client/src/core-repo/archive.js";
import { CoreRepoInstallError, installCoreRepo, type CoreRepoTransport } from "../../packages/sync-client/src/core-repo/installer.js";
import { coreSyncTimerFiles } from "../../packages/sync-client/src/cli/commands/core.js";

interface RawEntry { name: string; type?: "0" | "1" | "2" | "5"; content?: string; link?: string }

/** A minimal ustar writer, so hostile names and types reach the reader verbatim. */
function rawTar(entries: RawEntry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const skill = (name: string) => `---\nname: ${name}\n---\n# ${name}\n`;
const good = (commit: string, skills: string[]) => rawTar([{ name: "root/", type: "5" },
  ...skills.map(name => ({ name: `root/skills/${name}/SKILL.md`, content: skill(name) }))]);
const pinFor = (commit: string, bytes: Uint8Array, slug = "acme") => ({ orgId: "org_acme1", slug, commit, bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex") });

describe("Matrix Core repo archive rules", () => {
  // Fault: an org tarball writes outside the release, links to host files, or exhausts the disk.
  it.each([
    ["path traversal", [{ name: "root/../evil", content: "x" }]],
    ["absolute path", [{ name: "/etc/cron.d/evil", content: "x" }]],
    ["second top-level root", [{ name: "root/a", content: "x" }, { name: "other/b", content: "y" }]],
    ["symlink", [{ name: "root/link", type: "2", link: "/etc/passwd" }]],
    ["hard link", [{ name: "root/a", content: "x" }, { name: "root/b", type: "1", link: "root/a" }]],
    ["file reused as directory", [{ name: "root/a", content: "x" }, { name: "root/a/b", content: "y" }]],
    ["duplicate path", [{ name: "root/a", content: "x" }, { name: "root/a", content: "y" }]],
    ["backslash", [{ name: "root\\..\\evil", content: "x" }]],
  ] as Array<[string, RawEntry[]]>)("rejects %s", async (_label, entries) => {
    await expect(inspectCoreRepoArchive(rawTar(entries))).rejects.toThrow("CoreRepoArchiveRejected");
  });

  it("rejects archives over the entry cap and accepts a normal repo", async () => {
    const many = Array.from({ length: CORE_REPO_MAX_ENTRIES + 1 }, (_, index) => ({ name: `root/f${index}`, content: "" }));
    await expect(inspectCoreRepoArchive(rawTar(many))).rejects.toThrow("CoreRepoArchiveRejected");
    expect(await inspectCoreRepoArchive(good("a", ["deploy"]))).toEqual(["skills/deploy/SKILL.md"]);
    await expect(inspectCoreRepoArchive(Buffer.from("not gzip"))).rejects.toThrow("CoreRepoArchiveRejected");
  });
});

describe("Matrix Core repo installer", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "core-install-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const transportFor = (pins: Array<ReturnType<typeof pinFor>>, bytes: Map<string, Uint8Array>): CoreRepoTransport => ({
    listPins: async () => ({ pins, membershipVerified: true }),
    downloadTarball: async (pin) => bytes.get(pin.commit)!,
  });

  // Fault: a failed skill sync leaves the new release current, half-linked.
  it("rolls back to the previous release when the skill sync fails", async () => {
    const a = "a".repeat(40), b = "b".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])], [b, good(b, ["deploy", "review"])]]);
    const sync = vi.fn(async () => {});
    await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: sync });
    sync.mockRejectedValueOnce(new Error("script failed"));
    const results = await installCoreRepo({ root, transport: transportFor([pinFor(b, bytes.get(b)!)], bytes), runSkillSync: sync });
    expect(results).toEqual([{ orgId: "org_acme1", status: "failed" }]);
    expect(readlinkSync(join(root, "org_acme1", "current"))).toBe(`releases/${a}-acme`);
    expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ namespace: "org-acme-", source: join(root, "org_acme1", "current", ".matrix-skills") }));
  });

  // Fault: a 503, a network error, or an unverified pins list removes an org the user still belongs to.
  it("removes an org only when the platform confirms membership", async () => {
    const a = "a".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])]]);
    const sync = vi.fn(async () => {});
    await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: sync });
    const unverified: CoreRepoTransport = { listPins: async () => ({ pins: [], membershipVerified: false }), downloadTarball: vi.fn() };
    expect(await installCoreRepo({ root, transport: unverified, runSkillSync: sync })).toEqual([]);
    const down: CoreRepoTransport = { listPins: async () => { throw new CoreRepoInstallError("pins_unavailable"); }, downloadTarball: vi.fn() };
    await expect(installCoreRepo({ root, transport: down, runSkillSync: sync })).rejects.toBeInstanceOf(CoreRepoInstallError);
    expect(existsSync(join(root, "org_acme1", "current"))).toBe(true);
    expect(await installCoreRepo({ root, transport: transportFor([], bytes), runSkillSync: sync })).toEqual([{ orgId: "org_acme1", status: "removed" }]);
  });

  it("treats a pins response without the membership signal as unverified", async () => {
    const { createCoreRepoHttpTransport } = await import("../../packages/sync-client/src/core-repo/installer.js");
    const fetchFor = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
    const transport = (body: unknown, status?: number) => createCoreRepoHttpTransport({ baseUrl: "https://app.matrix-os.test", headers: {}, fetchImpl: fetchFor(body, status) });
    expect(await transport({ pins: [] }).listPins()).toEqual({ pins: [], membershipVerified: false });
    expect(await transport({ pins: [], membership: "verified" }).listPins()).toEqual({ pins: [], membershipVerified: true });
    await expect(transport({ error: "unavailable" }, 503).listPins()).rejects.toBeInstanceOf(CoreRepoInstallError);
  });

  type SyncCall = { source: string; namespace: string; emptySource: boolean };
  const recordingSync = (fail: (call: SyncCall) => boolean = () => false) => {
    const calls: SyncCall[] = [];
    const run = vi.fn(async (input: { source: string; namespace: string }) => {
      const call = { source: input.source, namespace: input.namespace, emptySource: readdirSync(input.source).length === 0 };
      calls.push(call);
      if (fail(call)) throw new Error("script failed");
    });
    return { calls, run };
  };

  // Fault: a failed first install leaves skills linked to a release that is no longer current.
  it("unlinks the namespace after a failed first install", async () => {
    const a = "a".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])]]);
    const sync = recordingSync(call => !call.emptySource);
    expect(await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: sync.run }))
      .toEqual([{ orgId: "org_acme1", status: "failed" }]);
    expect(sync.calls.map(call => [call.namespace, call.emptySource])).toEqual([["org-acme-", false], ["org-acme-", true]]);
    expect(existsSync(join(root, "org_acme1", "current"))).toBe(false);
  });

  // Fault: an org slug change leaves the old `org-<old>-*` links behind.
  it("moves skills to the new namespace when the org slug changes, even at the same commit", async () => {
    const a = "a".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])]]);
    const sync = recordingSync();
    await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: sync.run });
    sync.calls.length = 0;
    expect(await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!, "acme-co")], bytes), runSkillSync: sync.run }))
      .toEqual([{ orgId: "org_acme1", status: "installed", commit: a }]);
    expect(sync.calls.map(call => [call.namespace, call.emptySource])).toEqual([["org-acme-", true], ["org-acme-co-", false]]);
    expect(readdirSync(join(root, "org_acme1", "current", ".matrix-skills"))).toEqual(["org-acme-co-deploy"]);
    expect(await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!, "acme-co")], bytes), runSkillSync: sync.run }))
      .toEqual([{ orgId: "org_acme1", status: "current", commit: a }]);
  });

  // Fault: a skill whose combined name exceeds the sync script's limit silently disappears.
  it("reports skills it cannot install instead of skipping them silently", async () => {
    const a = "a".repeat(40);
    const slug = "s".repeat(32);
    const long = "x".repeat(64);
    const bytes = new Map([[a, rawTar([{ name: "root/", type: "5" },
      { name: `root/skills/${long}/SKILL.md`, content: skill(long) },
      { name: "root/skills/Bad_Name/SKILL.md", content: skill("bad") },
      { name: "root/skills/ok/SKILL.md", content: skill("ok") }])]]);
    const [result] = await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!, slug)], bytes), runSkillSync: async () => {} });
    expect(result).toEqual({ orgId: "org_acme1", status: "installed", commit: a, rejectedSkills: [long, "bad_name"] });
    expect(readdirSync(join(root, "org_acme1", "current", ".matrix-skills"))).toEqual([`org-${slug}-ok`]);
  });

  // Fault: two overlapping runs (timer + manual) interleave renames.
  it("refuses a concurrent run but recovers a stale lock, and sweeps stale staging dirs only", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".lock"), "1");
    const transport = transportFor([], new Map());
    await expect(installCoreRepo({ root, transport, runSkillSync: async () => {} })).rejects.toBeInstanceOf(CoreRepoInstallError);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(root, ".lock"), old, old);
    expect(await installCoreRepo({ root, transport, runSkillSync: async () => {} })).toEqual([]);

    const a = "a".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])]]);
    mkdirSync(join(root, "org_acme1", ".staging-old"), { recursive: true });
    utimesSync(join(root, "org_acme1", ".staging-old"), old, old);
    mkdirSync(join(root, "org_acme1", ".staging-fresh"), { recursive: true });
    await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: async () => {} });
    expect(existsSync(join(root, "org_acme1", ".staging-old"))).toBe(false);
    expect(existsSync(join(root, "org_acme1", ".staging-fresh"))).toBe(true);
  });

  // Fault: a live run longer than the lock age is reclaimed, or one run releases another run's lock.
  it("reclaims a lock only from a dead owner, renews it while running, and releases only its own", async () => {
    const lock = join(root, ".lock");
    mkdirSync(root, { recursive: true });
    const transport = transportFor([], new Map());
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(lock, JSON.stringify({ pid: dead, token: "dead-run" }));
    expect(await installCoreRepo({ root, transport, runSkillSync: async () => {} })).toEqual([]);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "live-run" }));
    const stale = new Date(Date.now() - 20 * 60_000);
    utimesSync(lock, stale, stale);
    await expect(installCoreRepo({ root, transport, runSkillSync: async () => {} })).rejects.toBeInstanceOf(CoreRepoInstallError);
    rmSync(lock);

    const a = "a".repeat(40);
    const bytes = new Map([[a, good(a, ["deploy"])]]);
    let renewedDuringRun = false;
    const slowSync = async () => {
      utimesSync(lock, stale, stale);
      await new Promise(resolve => setTimeout(resolve, 120));
      renewedDuringRun = Date.now() - statSync(lock).mtimeMs < 60_000;
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    };
    await installCoreRepo({ root, transport: transportFor([pinFor(a, bytes.get(a)!)], bytes), runSkillSync: slowSync, lockHeartbeatMs: 20 });
    expect(renewedDuringRun).toBe(true);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("someone-else");
  });

  it("writes hourly timer units that run `core sync`", () => {
    const linux = coreSyncTimerFiles({ platform: "linux", home: "/home/u", node: "/usr/bin/node", cli: "/opt/matrix/cli.mjs" });
    expect(linux.map(file => file.path)).toEqual(["/home/u/.config/systemd/user/matrix-core-sync.service", "/home/u/.config/systemd/user/matrix-core-sync.timer"]);
    expect(linux[0]!.content).toContain('ExecStart="/usr/bin/node" "/opt/matrix/cli.mjs" core sync');
    expect(linux[1]!.content).toContain("OnUnitActiveSec=1h");
    const mac = coreSyncTimerFiles({ platform: "darwin", home: "/Users/u", node: "/usr/bin/node", cli: "/a&b/cli.mjs" });
    expect(mac[0]!.content).toContain("<integer>3600</integer>");
    expect(mac[0]!.content).toContain("/a&amp;b/cli.mjs");
    expect(() => coreSyncTimerFiles({ platform: "linux", home: "/h", node: "/n", cli: "/x\"; rm -rf ~" })).toThrow();
  });
});
