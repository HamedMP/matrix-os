import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Static and render checks for the metal-host provisioning scripts. The live
// proof is distro/metal-host/smoke-host.sh on a real host (docs/dev/metal-hosts.md);
// these checks catch the faults that would hurt a shared host before anyone
// runs them: a syntax error, an unpinned hypervisor, snapshots landing on the
// root filesystem (the S7 failure), a firewall that flushes other tables, or a
// golden disk built without the S7 guest settings.

const run = promisify(execFile);
const DIR = "distro/metal-host";
const SCRIPTS = [
  `${DIR}/provision-host.sh`,
  `${DIR}/build-golden-disk.sh`,
  `${DIR}/smoke-host.sh`,
  `${DIR}/matrix-hostd-nft`,
  `${DIR}/guest/metal-guest-setup.sh`,
];
const CH_SHA256 = "f9ffb9646783233d1f0fb09e77db1fca66499d1041e63bc011b90683c0d49933";
const CH_REMOTE_SHA256 = "06c111b691ee085c0392e6d53f6600131e425e54669546dd0f2c40bdedc8e5ce";

function findShellcheck(): string | null {
  if (process.env.SHELLCHECK && existsSync(process.env.SHELLCHECK)) return process.env.SHELLCHECK;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "shellcheck");
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(path)));
    else out.push(path);
  }
  return out;
}

async function renderNft(mode: "exclusive" | "coexist"): Promise<string> {
  const { stdout } = await run("bash", [
    `${DIR}/matrix-hostd-nft`, "render",
    "--template", `${DIR}/nftables.conf`,
    "--wan", "eno1",
    "--ingress-port", "9443",
    "--api-port", "8443",
    "--mode", mode,
  ]);
  return stdout;
}

describe("metal host scripts", () => {
  let work: string;
  let agent: string;
  const AGENT_SOURCE = "// stand-in guest agent bundle\nexport {};\n";
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "metal-host-scripts-"));
    agent = join(work, "agent.mjs");
    await writeFile(agent, AGENT_SOURCE);
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("every script parses with bash -n and passes shellcheck", async () => {
    const shellcheck = findShellcheck();
    // A missing linter must fail the lane, never skip it silently.
    expect(shellcheck, "shellcheck must be on PATH or in $SHELLCHECK").not.toBeNull();
    for (const script of SCRIPTS) {
      await expect(run("bash", ["-n", script]), script).resolves.toBeDefined();
    }
    await expect(run(shellcheck!, ["--severity=style", "--shell=bash", "-x", ...SCRIPTS])).resolves.toBeDefined();
  });

  it("never pipes into grep -q, which pipefail turns into a false miss", async () => {
    // A SIGPIPE'd `nft list ... | grep -q` once read as "no ruleset", chose the
    // default-deny firewall and locked a shared host out of SSH.
    for (const script of SCRIPTS) {
      const code = (await readFile(script, "utf8")).split("\n").filter((line) => !line.trim().startsWith("#"));
      expect(code.filter((line) => /\|\s*grep\s+-[a-zA-Z]*q/.test(line)), script).toEqual([]);
    }
  });

  it("never guesses the default-deny firewall and arms a revert on every change", async () => {
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    const auto = provision.slice(provision.indexOf('if [ "$firewall" = auto ]'), provision.indexOf("install -d -m 0755 \"$ETC_DIR\""));
    expect(auto).toContain("firewall=coexist");
    expect(auto).not.toContain("firewall=exclusive");
    expect(provision).toMatch(/systemd-run[^\n]*--unit matrix-hostd-nft-revert --on-active=\d+/);
    expect(provision).toContain("/usr/bin/systemctl disable --now matrix-hostd-nft.service");
    expect(provision).toContain("--confirm-firewall");
  });

  it("pins Cloud Hypervisor v54.1 and its ch-remote by sha256", async () => {
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    expect(provision).toContain("releases/download/v54.1/cloud-hypervisor-static");
    expect(provision).toContain("releases/download/v54.1/ch-remote-static");
    expect(provision).toContain(CH_SHA256);
    expect(provision).toContain(CH_REMOTE_SHA256);
    // Node is pinned the same way: an exact tarball and its checksum, never curl | bash.
    expect(provision).toMatch(/node-v24\.\d+\.\d+-linux-x64\.tar\.xz/);
    expect(provision).not.toMatch(/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh/);
  });

  it("keeps snapshots on their own LV and never writes under /var/lib/spike", async () => {
    for (const file of await allFiles(DIR)) {
      expect(await readFile(file, "utf8"), file).not.toContain("/var/lib/spike");
    }
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    expect(provision).toMatch(/\/dev\/vmvg\/hostd-snapshots \/var\/lib\/matrix-hostd\/snapshots ext4/);
    // The smoke refuses to pass when the snapshot is not on that LV.
    const smoke = await readFile(`${DIR}/smoke-host.sh`, "utf8");
    expect(smoke).toContain("findmnt");
    expect(smoke).toContain("hostd--snapshots");
  });

  it("never flushes the ruleset and only defines its own tables", async () => {
    for (const file of await allFiles(DIR)) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/flush\s+ruleset/);
    }
    for (const mode of ["exclusive", "coexist"] as const) {
      const rules = await renderNft(mode);
      const tables = [...rules.matchAll(/^table\s+(\S+)\s+(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
      expect(new Set(tables)).toEqual(new Set(["inet matrix_hostd", "ip matrix_hostd_nat"]));
      expect(rules).not.toContain("@");
      expect(rules).toMatch(/iifname "brmx" tcp dport 25 drop/);
      expect(rules).toMatch(/ip saddr 10\.78\.0\.0\/22 oifname "eno1" masquerade/);
      expect(rules).toMatch(/tcp dport 9443 accept/);
      expect(rules).toMatch(/tcp dport 8443 accept/);
      expect(rules).toMatch(/iifname "brmx" drop/);
    }
    const exclusive = await renderNft("exclusive");
    expect(exclusive).toMatch(/hook input priority \d+; policy drop;/);
    expect(exclusive).toMatch(/hook forward priority \d+; policy drop;/);
    expect(exclusive).toMatch(/iifname "tailscale0" tcp dport 22 accept/);
    expect(exclusive).not.toMatch(/^\s*tcp dport 22 accept/m);
    // Coexisting with another ruleset (the S7 spike), hostd must not drop its traffic.
    const coexist = await renderNft("coexist");
    expect(coexist).toMatch(/hook input priority \d+; policy accept;/);
    expect(coexist).not.toMatch(/dport 22/);
  });

  it("shapes each VM tap to 50 Mbit/s and keeps the VMM unprivileged", async () => {
    for (const unit of ["matrix-vm@.service", "matrix-vm-restore@.service"]) {
      const text = await readFile(`${DIR}/systemd/${unit}`, "utf8");
      expect(text, unit).toMatch(/tc filter add dev \$\{TAP\} parent ffff: .*police rate 50mbit/);
      expect(text, unit).toMatch(/^User=matrix-vm$/m);
      expect(text, unit).not.toMatch(/AmbientCapabilities/);
      expect(text, unit).toMatch(/RequiresMountsFor=\/var\/lib\/matrix-hostd\/snapshots/);
    }
  });

  it("renders the unchanged golden builder cloud-init plus the S7 guest settings", async () => {
    const out = join(work, "builder.mime");
    await run("python3", [
      "-I", `${DIR}/render-user-data.py`, "builder",
      "--template", "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml",
      "--guest-dir", `${DIR}/guest`,
      "--guest-agent", agent,
      "--var", `callbackToken=${"t".repeat(64)}`,
      "--var", "callbackUrl=http://10.78.0.1:9480/callback",
      "--var", "callbackEventId=evt-1",
      "--var", "builderBootEventId=evt-2",
      "--var", "bundleVersion=v2026.11.20-2087",
      "--var", `bundleSha256=${"a".repeat(64)}`,
      "--var", "bundleUrl=https://example.invalid/b.tgz",
      "--out", out,
    ]);
    const mime = await readFile(out, "utf8");
    const { stdout } = await run("python3", ["-I", "-c", [
      "import email, sys",
      "msg = email.message_from_string(open(sys.argv[1]).read())",
      "for part in msg.walk():",
      "    if part.get_content_maintype() == 'multipart': continue",
      "    print('=== ' + part.get_content_type())",
      "    print(part.get_payload(decode=True).decode())",
    ].join("\n"), out]);
    expect(mime).toMatch(/^Content-Type: multipart\/mixed/m);
    const template = await readFile("distro/customer-vps/golden-snapshot-builder-cloud-init.yaml", "utf8");
    // The builder flow itself is unchanged: every template line survives rendering.
    const rendered = stdout.split("=== text/x-shellscript")[0]!;
    for (const line of template.split("\n").filter((l) => l.trim() && !l.includes("{{"))) {
      expect(rendered).toContain(line);
    }
    expect(stdout).not.toMatch(/\{\{[a-zA-Z]/);
    expect(stdout).toContain("=== text/x-shellscript");
    // ptp_kvm comes from linux-modules-extra for the running (host-booted) kernel.
    expect(stdout).toContain('kernel="$(uname -r)"');
    expect(stdout).toContain('"linux-modules-extra-${kernel}"');
    expect(stdout).toContain("linuxptp");
    expect(stdout).toContain("ptp_kvm");
    // Files the guest part installs, decoded the way the guest decodes them.
    const installed = new Map(
      [...stdout.matchAll(/^decode '([A-Za-z0-9+/=]+)' (\S+) \d+$/gm)].map((m) => [m[2]!, Buffer.from(m[1]!, "base64").toString()]),
    );
    expect(installed.get("/opt/matrix/guest-agent/agent.mjs")).toBe(AGENT_SOURCE);
    expect(installed.get("/etc/systemd/system/phc2sys-kvm.service")).toContain(
      "ExecStart=/usr/sbin/phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -O 0 -R 4 -S 0.5",
    );
    expect(installed.get("/etc/systemd/system/matrix-guest-agent.service")).toContain("/opt/matrix/guest-agent/agent.mjs");
    expect(installed.get("/etc/systemd/system/matrix-guest-agent-vsock.service")).toContain("VSOCK-LISTEN:1024");
    expect(stdout).toContain("systemctl enable phc2sys-kvm.service matrix-guest-agent.service matrix-guest-agent-vsock.service");
  });

  it("refuses to render with a placeholder left unfilled", async () => {
    await expect(
      run("python3", [
        "-I", `${DIR}/render-user-data.py`, "builder",
        "--template", "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml",
        "--guest-dir", `${DIR}/guest`,
        "--guest-agent", agent,
        "--out", join(work, "missing.mime"),
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("unrendered placeholders") });
  });

  it("renders smoke user-data for the golden fast path that fits the hostd body limit", async () => {
    const out = join(work, "smoke.yaml");
    await run("python3", [
      "-I", `${DIR}/render-user-data.py`, "smoke",
      "--template", "distro/customer-vps/cloud-init.yaml",
      "--var", "handle=smoke-abc",
      "--var", "imageVersion=v2026.11.20-2087",
      "--var", `targetBundleSha256=${"b".repeat(64)}`,
      "--out", out,
    ]);
    const text = await readFile(out, "utf8");
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    expect(text).not.toMatch(/\{\{[a-zA-Z]/);
    expect(text).toContain("MATRIX_IMAGE_SOURCE=snapshot");
    expect(text).toContain("MATRIX_SNAPSHOT_SOURCE_VERSION=v2026.11.20-2087");
    expect(text).toContain("/opt/matrix/restore-complete");
    // hostd caps the whole JSON request at 64 KiB.
    expect(Buffer.byteLength(JSON.stringify({ userData: text }))).toBeLessThan(60 * 1024);
  });
});
