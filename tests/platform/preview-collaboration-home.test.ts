import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCollaborationEnrollment, registerCollaborationHome, waitForCollaborationEnrollment } from "../../scripts/preview-collaboration-staging.mjs";

const HANDLE = "pr-1990";
const OWNER = "user_collaborationowner";
const MACHINE = "3f6b1a2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const TOKEN = "a".repeat(64);
const PRODUCTION_URL = "https://platform.example.test";
const BINDING = {
  PLATFORM_INTERNAL_URL: "https://pr-1990---preview.example.test",
  UPGRADE_TOKEN: "b".repeat(64),
  MATRIX_COLLABORATION_CLIENT_ORIGINS: "https://preview.example.test",
};
const ORIGINAL = [
  `MATRIX_MACHINE_ID=${MACHINE}`,
  `MATRIX_CLERK_USER_ID=${OWNER}`,
  `MATRIX_HANDLE=${HANDLE}`,
  `MATRIX_RUNTIME_SLOT=${HANDLE}`,
  "MATRIX_DEVELOPER_TOOLS='[\"codex\"]'",
  `PLATFORM_INTERNAL_URL=${PRODUCTION_URL}`,
  `UPGRADE_TOKEN=${TOKEN}`,
  `MATRIX_AUTH_TOKEN=${TOKEN}`,
  "MATRIX_PLATFORM_SPEECH_ORIGIN=https://platform.example.test",
  "",
].join("\n");
const GUARD_SOURCE = readFileSync("scripts/preview-collaboration-guard.py", "utf8");
const NONCE = "100-1";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "preview-collaboration-home-"));
  writeFileSync(join(root, "host.env"), ORIGINAL);
  chmodSync(join(root, "host.env"), 0o640);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function python(script: string, call: string, ...args: string[]) {
  return spawnSync("python3", ["-I", "-c", `import json,runpy,sys,pathlib\nm=runpy.run_path(sys.argv[1],run_name="fixture")\nr=${call}\nprint(json.dumps(r))`, resolve(script), root, ...args], { encoding: "utf8", timeout: 10_000 });
}

function applyAs(nonce: string, binding: unknown = BINDING, handle = HANDLE, owner = OWNER, machine = MACHINE) {
  return python("scripts/preview-collaboration-home.py",
    `m["apply"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6],json.loads(sys.argv[7]),root_owned=False)`,
    nonce, handle, owner, machine, JSON.stringify(binding));
}

function guard(command: "restore" | "commit", nonce: string) {
  return python("scripts/preview-collaboration-guard.py", `m["${command}"](pathlib.Path(sys.argv[2]),sys.argv[3])`, nonce);
}

function prepare() {
  return python("scripts/preview-collaboration-guard.py",
    'm["prepare"](pathlib.Path(sys.argv[2]),sys.argv[3])', GUARD_SOURCE);
}

// Tests stand in for `systemctl is-active` on the run's guard timer.
function claim(nonce: string, timerArmed = true) {
  expect(JSON.parse(prepare().stdout)).toBe("prepared");
  return python("scripts/preview-collaboration-guard.py",
    `m["claim"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],lambda nonce: sys.argv[5] == "true")`,
    nonce, GUARD_SOURCE, String(timerArmed));
}

// The workflow's order on the host: arm the guard, claim, then apply as the claiming run.
function connect(nonce: string, binding: unknown = BINDING) {
  expect(JSON.parse(claim(nonce).stdout)).toBe("claimed");
  return applyAs(nonce, binding);
}

function apply(binding: unknown = BINDING, handle = HANDLE, owner = OWNER, machine = MACHINE) {
  expect(JSON.parse(claim(NONCE).stdout)).toBe("claimed");
  return applyAs(NONCE, binding, handle, owner, machine);
}

const hostEnv = () => readFileSync(join(root, "host.env"), "utf8");
const envValue = (key: string) => hostEnv().split("\n").filter((line) => line.startsWith(`${key}=`));

describe("preview collaboration host scripts", () => {
  it("requires the executable rollback guard to be installed before a timer may be claimed", () => {
    const unprepared = python("scripts/preview-collaboration-guard.py",
      'm["claim"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],lambda nonce: True)',
      "100-1", GUARD_SOURCE);
    expect(unprepared.status).not.toBe(0);
    expect(existsSync(join(root, ".preview-collaboration-state"))).toBe(false);
    expect(JSON.parse(prepare().stdout)).toBe("prepared");
    expect(statSync(join(root, ".preview-collaboration-guard.py")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(python("scripts/preview-collaboration-guard.py",
      'm["claim"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],lambda nonce: True)',
      "100-1", GUARD_SOURCE).stdout)).toBe("claimed");
  });
  it("refuses a replaced guard script before moving ownership", () => {
    expect(JSON.parse(prepare().stdout)).toBe("prepared");
    rmSync(join(root, ".preview-collaboration-guard.py"));
    writeFileSync(join(root, "other.py"), GUARD_SOURCE);
    symlinkSync(join(root, "other.py"), join(root, ".preview-collaboration-guard.py"));
    const claimWithSymlink = python("scripts/preview-collaboration-guard.py",
      'm["claim"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],lambda nonce: True)',
      "100-1", GUARD_SOURCE);
    expect(claimWithSymlink.status).not.toBe(0);
    expect(existsSync(join(root, ".preview-collaboration-state"))).toBe(false);
  });
  it("refuses a claim whose guard timer already fired, leaving the earlier owner in charge", () => {
    expect(connect("108-1").status).toBe(0);
    // Run 109 stalled past its timer between arming and claiming.
    const late = claim("109-1", false);
    expect(late.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".preview-collaboration-state"), "utf8"))).toEqual({ nonce: "108-1", state: "claimed" });
    expect(applyAs("109-1").status).not.toBe(0);
    // Run 108's timer still restores its own connection.
    expect(JSON.parse(guard("restore", "108-1").stdout)).toBe("restored");
    expect(hostEnv()).toBe(ORIGINAL);
  });

  it("applies only as the run that currently owns the connection", () => {
    // No claim at all.
    expect(applyAs("101-1").status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
    // A newer run claimed after this one.
    expect(JSON.parse(claim("102-1").stdout)).toBe("claimed");
    expect(JSON.parse(claim("103-1").stdout)).toBe("claimed");
    expect(applyAs("102-1").status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
    // The guard fired (restored) before the apply ran: the apply must not re-point afterwards.
    expect(applyAs("103-1").status).toBe(0);
    expect(JSON.parse(guard("restore", "103-1").stdout)).toBe("restored");
    expect(applyAs("103-1").status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
  });

  it("proves the host is this collaboration preview before reporting its machine", () => {
    const probe = (handle: string, owner: string) => python("scripts/preview-collaboration-probe.py", `m["identity"](pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4])`, handle, owner);
    const accepted = probe(HANDLE, OWNER);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toBe(MACHINE);
    for (const [handle, owner] of [["pr-1991", OWNER], [HANDLE, "user_someoneelse"], ["alice", OWNER]]) {
      const refused = probe(handle!, owner!);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
    }
    writeFileSync(join(root, "host.env"), ORIGINAL.replace(`MATRIX_RUNTIME_SLOT=${HANDLE}`, "MATRIX_RUNTIME_SLOT=primary"));
    expect(probe(HANDLE, OWNER).status).not.toBe(0);
  });

  it("re-points only the collaboration binding and keeps owner, group and mode", () => {
    const before = statSync(join(root, "host.env"));
    const result = apply();
    expect(result.status, result.stderr).toBe(0);
    const after = statSync(join(root, "host.env"));
    expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, 0o640]);
    expect(envValue("PLATFORM_INTERNAL_URL")).toEqual([`PLATFORM_INTERNAL_URL=${BINDING.PLATFORM_INTERNAL_URL}`]);
    expect(envValue("UPGRADE_TOKEN")).toEqual([`UPGRADE_TOKEN=${BINDING.UPGRADE_TOKEN}`]);
    expect(envValue("MATRIX_COLLABORATION_CLIENT_ORIGINS")).toEqual([`MATRIX_COLLABORATION_CLIENT_ORIGINS=${BINDING.MATRIX_COLLABORATION_CLIENT_ORIGINS}`]);
    // Exact-head preview deploys keep reading release metadata from the platform that published it.
    expect(envValue("MATRIX_UPDATE_MANIFEST_BASE_URL")).toEqual([`MATRIX_UPDATE_MANIFEST_BASE_URL=${PRODUCTION_URL}`]);
    // The production proxy credential keeps the /vm/pr-<N> control channel alive for rollback.
    expect(envValue("MATRIX_AUTH_TOKEN")).toEqual([`MATRIX_AUTH_TOKEN=${TOKEN}`]);
    expect(hostEnv()).toContain("MATRIX_DEVELOPER_TOOLS='[\"codex\"]'");
    expect(result.stdout).not.toContain(BINDING.UPGRADE_TOKEN);
  });

  it("installs the guard and records the claim before anything else changes", () => {
    expect(JSON.parse(claim("101-1").stdout)).toBe("claimed");
    expect(statSync(join(root, ".preview-collaboration-guard.py")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, ".preview-collaboration-guard.py"), "utf8")).toBe(GUARD_SOURCE);
    expect(JSON.parse(readFileSync(join(root, ".preview-collaboration-state"), "utf8"))).toEqual({ nonce: "101-1", state: "claimed" });
    expect(hostEnv()).toBe(ORIGINAL);
    // A runner lost after arming but before applying leaves nothing to restore on a first connection,
    // and a runner that resumes after its timer fired cannot apply any more.
    expect(JSON.parse(guard("restore", "101-1").stdout)).toBe("none");
    expect(applyAs("101-1").status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
  });

  it("keeps exactly one rollback copy: the host environment before the first connection", () => {
    expect(apply().status).toBe(0);
    expect(apply({ ...BINDING, UPGRADE_TOKEN: "c".repeat(64) }).status).toBe(0);
    const rollback = join(root, ".host.env.preview-collaboration-rollback");
    expect(readFileSync(rollback, "utf8")).toBe(ORIGINAL);
    expect(statSync(rollback).mode & 0o7777).toBe(0o640);
    expect(envValue("MATRIX_UPDATE_MANIFEST_BASE_URL")).toEqual([`MATRIX_UPDATE_MANIFEST_BASE_URL=${PRODUCTION_URL}`]);
    expect(readdirSync(root).filter((name) => name.includes("rollback") || name.startsWith(".pc-tmp."))).toEqual([".host.env.preview-collaboration-rollback"]);
  });

  it.each([
    ["an unexpected key", { ...BINDING, MATRIX_AUTH_TOKEN: TOKEN }],
    ["a missing key", { PLATFORM_INTERNAL_URL: BINDING.PLATFORM_INTERNAL_URL, UPGRADE_TOKEN: BINDING.UPGRADE_TOKEN }],
    ["a plain-http platform", { ...BINDING, PLATFORM_INTERNAL_URL: "http://pr-1990---preview.example.test" }],
    ["a platform with a path", { ...BINDING, PLATFORM_INTERNAL_URL: "https://preview.example.test/api" }],
    ["a short token", { ...BINDING, UPGRADE_TOKEN: "abc" }],
    ["an injected line", { ...BINDING, MATRIX_COLLABORATION_CLIENT_ORIGINS: "https://preview.example.test\nMATRIX_AUTH_TOKEN=x" }],
  ])("refuses %s without touching the host environment", (_label, binding) => {
    const result = apply(binding);
    expect(result.status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
    expect(existsSync(join(root, ".host.env.preview-collaboration-rollback"))).toBe(false);
    expect(result.stderr).not.toContain(BINDING.UPGRADE_TOKEN);
  });

  it.each([
    ["another preview", "pr-1991", OWNER, MACHINE],
    ["a customer runtime", "alice", OWNER, MACHINE],
    ["another owner", HANDLE, "user_someoneelse", MACHINE],
    ["another machine", HANDLE, OWNER, "0f6b1a2c-4d5e-4f60-8a7b-9c0d1e2f3a4b"],
  ])("never re-points %s", (_label, handle, owner, machine) => {
    expect(apply(BINDING, handle, owner, machine).status).not.toBe(0);
    expect(hostEnv()).toBe(ORIGINAL);
  });

  it("refuses a symlinked or group-writable host environment", () => {
    chmodSync(join(root, "host.env"), 0o660);
    expect(apply().status).not.toBe(0);
    chmodSync(join(root, "host.env"), 0o640);
    rmSync(join(root, "host.env"));
    writeFileSync(join(root, "real.env"), ORIGINAL);
    symlinkSync(join(root, "real.env"), join(root, "host.env"));
    expect(apply().status).not.toBe(0);
    expect(lstatSync(join(root, "host.env")).isSymbolicLink()).toBe(true);
  });

  it("restores the pre-connection host environment while its own claim is uncommitted", () => {
    expect(connect("101-1").status).toBe(0);
    const restored = guard("restore", "101-1");
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toBe("restored");
    expect(hostEnv()).toBe(ORIGINAL);
    expect(statSync(join(root, "host.env")).mode & 0o7777).toBe(0o640);
    expect(existsSync(join(root, ".host.env.preview-collaboration-rollback"))).toBe(false);
    expect(JSON.parse(guard("restore", "101-1").stdout)).toBe("unchanged");
    // A commit after a restore must fail, so the workflow never reports a connection the guard undid.
    expect(guard("commit", "101-1").status).not.toBe(0);
  });

  it("leaves a committed connection in place when its guard fires", () => {
    expect(connect("102-1").status).toBe(0);
    expect(JSON.parse(guard("commit", "102-1").stdout)).toBe("committed");
    expect(JSON.parse(guard("restore", "102-1").stdout)).toBe("unchanged");
    expect(envValue("UPGRADE_TOKEN")).toEqual([`UPGRADE_TOKEN=${BINDING.UPGRADE_TOKEN}`]);
    // A later connection that fails before committing returns the home to its original binding.
    expect(connect("103-1", { ...BINDING, UPGRADE_TOKEN: "d".repeat(64) }).status).toBe(0);
    expect(JSON.parse(guard("restore", "103-1").stdout)).toBe("restored");
    expect(hostEnv()).toBe(ORIGINAL);
  });

  it("never lets an earlier run's timer undo a newer connection", () => {
    // Run 104 is cancelled after applying; its armed timer outlives it.
    expect(connect("104-1").status).toBe(0);
    // Run 105 supersedes it and commits.
    expect(connect("105-1", { ...BINDING, UPGRADE_TOKEN: "e".repeat(64) }).status).toBe(0);
    expect(JSON.parse(guard("commit", "105-1").stdout)).toBe("committed");
    expect(JSON.parse(guard("restore", "104-1").stdout)).toBe("unchanged");
    expect(envValue("UPGRADE_TOKEN")).toEqual([`UPGRADE_TOKEN=${"e".repeat(64)}`]);
    // Nor can the superseded run commit.
    expect(guard("commit", "104-1").status).not.toBe(0);
    // Before the newer run commits, the earlier timer is also powerless.
    expect(connect("106-1", { ...BINDING, UPGRADE_TOKEN: "f".repeat(64) }).status).toBe(0);
    expect(JSON.parse(guard("restore", "105-1").stdout)).toBe("unchanged");
    expect(envValue("UPGRADE_TOKEN")).toEqual([`UPGRADE_TOKEN=${"f".repeat(64)}`]);
  });

  it("refuses to restore from a symlinked rollback copy", () => {
    expect(connect("107-1").status).toBe(0);
    rmSync(join(root, ".host.env.preview-collaboration-rollback"));
    writeFileSync(join(root, "elsewhere"), "MATRIX_HANDLE=alice\n");
    symlinkSync(join(root, "elsewhere"), join(root, ".host.env.preview-collaboration-rollback"));
    expect(guard("restore", "107-1").status).not.toBe(0);
    expect(envValue("UPGRADE_TOKEN")).toEqual([`UPGRADE_TOKEN=${BINDING.UPGRADE_TOKEN}`]);
  });

  it("accepts only run-attempt nonces on the command line", () => {
    for (const argv of [["restore", "run-1"], ["commit", "1-1;x"], ["claim", "1-1"], ["restore", "1-1", "--now"]]) {
      const result = spawnSync("python3", ["-I", resolve("scripts/preview-collaboration-guard.py"), ...argv], { encoding: "utf8" });
      expect(result.status, argv.join(" ")).not.toBe(0);
    }
  });

  it("reports gateway health and collaboration configuration without printing the token", () => {
    const script = `import json,runpy,sys,pathlib,io
m=runpy.run_path(sys.argv[1],run_name="fixture")
seen=[]
class R(io.StringIO):
    status=200
    def __enter__(self): return self
    def __exit__(self,*a): return False
def opener(request,timeout):
    url=request if isinstance(request,str) else request.full_url
    seen.append((url, None if isinstance(request,str) else request.get_header("Authorization")))
    return R(json.dumps({"capabilities":{"collaboration":sys.argv[3]=="true"}}))
print(json.dumps([m["health"](pathlib.Path(sys.argv[2]),opener,lambda: 4242), seen[1][1]==f"Bearer {'a'*64}"]))`;
    for (const configured of [true, false]) {
      const result = spawnSync("python3", ["-I", "-c", script, resolve("scripts/preview-collaboration-probe.py"), root, String(configured)], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([{ healthy: true, collaboration: configured, pid: 4242 }, true]);
      expect(result.stdout).not.toContain(TOKEN);
    }
  });
});

class FakeClient {
  queries: Array<{ text: string; values: unknown[] }> = [];
  constructor(private readonly respond: (text: string) => { rowCount?: number; rows?: unknown[] } = () => ({ rowCount: 1, rows: [] })) {}
  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    return this.respond(text);
  }
}

const HOME = { handle: HANDLE, machineId: MACHINE, ownerId: OWNER, address: "203.0.113.7" };

describe("preview collaboration staging registration", () => {
  it("retires the share fixture and upserts the real machine in one transaction", async () => {
    const client = new FakeClient();
    await registerCollaborationHome(client, HOME, new Date("2026-09-28T00:00:00.000Z"));
    const texts = client.queries.map((query) => query.text.trim().split(/\s+/)[0]);
    expect(texts).toEqual(["BEGIN", "UPDATE", "INSERT", "COMMIT"]);
    const [, retire, upsert] = client.queries;
    expect(retire!.text).toContain("machine_id <> $2");
    expect(retire!.text).toContain("provisioning_class = 'preview'");
    expect(retire!.values).toEqual([HANDLE, MACHINE, `chat-share-preview-fixture-${HANDLE}`, "2026-09-28T00:00:00.000Z", OWNER]);
    expect(upsert!.text).toContain("'preview', $4, 'running', $5, '[]', '{}'");
    expect(upsert!.text).toContain("WHERE user_machines.clerk_user_id = EXCLUDED.clerk_user_id");
    expect(upsert!.values).toEqual([MACHINE, OWNER, HANDLE, "203.0.113.7", "2026-09-28T00:00:00.000Z"]);
  });

  it("refuses and rolls back when the machine belongs to someone else", async () => {
    const client = new FakeClient((text) => (text.includes("INSERT") ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] }));
    await expect(registerCollaborationHome(client, HOME)).rejects.toMatchObject({ code: "ownership_mismatch" });
    expect(client.queries.map((query) => query.text.trim().split(/\s+/)[0])).toEqual(["BEGIN", "UPDATE", "INSERT", "ROLLBACK"]);
  });

  it.each([
    { handle: "alice" }, { handle: "pr-0" }, { machineId: "chat-share-preview-pr-1990" },
    { ownerId: "user bad" }, { address: "203.0.113.256" }, { address: "example.test" },
  ])("validates %j before any query", async (override) => {
    const client = new FakeClient();
    await expect(registerCollaborationHome(client, { ...HOME, ...override })).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.queries).toEqual([]);
  });

  it("waits for a fresh registration and control stream under the logical runtime ID", async () => {
    let reads = 0;
    const client = new FakeClient(() => ({ rows: [{ enrolled: ++reads >= 3 }] }));
    const since = new Date("2026-09-28T00:00:00.000Z");
    let clock = 0;
    const enrolled = await waitForCollaborationEnrollment(client, HOME, {
      since, deadline: 60_000, intervalMs: 5_000, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    expect(enrolled).toBe(true);
    expect(client.queries[0]!.values).toEqual([`vps-${MACHINE}`, OWNER, HANDLE, since.toISOString()]);
    expect(client.queries[0]!.text).toContain("last_control_at >= $4::timestamptz");
    const never = new FakeClient(() => ({ rows: [] }));
    clock = 0;
    expect(await waitForCollaborationEnrollment(never, HOME, {
      since, deadline: 12_000, intervalMs: 5_000, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    })).toBe(false);
    expect(never.queries).toHaveLength(3);
    expect(await readCollaborationEnrollment(new FakeClient(() => ({ rows: [{ enrolled: false }] })), HOME, since)).toBe(false);
  });
});
