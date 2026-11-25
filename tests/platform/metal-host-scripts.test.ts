import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Static and render checks for the metal-host provisioning scripts. The live
// proof is distro/metal-host/smoke-host.sh on a real host (docs/dev/metal-hosts.md);
// these checks catch the faults that would hurt a shared host before anyone
// runs them: a syntax error, an unpinned hypervisor, snapshots landing on the
// root filesystem (the S7 failure), a firewall that flushes other tables, or a
// golden disk built without the S7 guest settings.

const run = promisify(execFile);
const DIR = "distro/metal-host";
const SCRIPTS = [
  `${DIR}/matrix-vm-network`,
  `${DIR}/provision-host.sh`,
  `${DIR}/build-golden-disk.sh`,
  `${DIR}/smoke-host.sh`,
  `${DIR}/matrix-hostd-nft`,
  `${DIR}/matrix-hostd-tls`,
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

async function renderNft(template = "nftables.conf"): Promise<string> {
  const { stdout } = await run("bash", [
    `${DIR}/matrix-hostd-nft`, "render",
    "--template", `${DIR}/${template}`,
    "--wan", "eno1",
    "--ingress-port", "9443",
    "--api-port", "8443",
  ]);
  return stdout;
}

// The lines of one chain of table inet matrix_hostd, in order.
function chain(rules: string, name: string): string[] {
  const body = new RegExp(`chain ${name} \\{([\\s\\S]*?)\\n  \\}`).exec(rules)?.[1] ?? "";
  return body.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("metal host scripts", () => {
  let work: string;
  let agent: string;
  let tokenFile: string;
  const callbackToken = "b".repeat(64);
  const AGENT_SOURCE = "// stand-in guest agent bundle\nexport {};\n";
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "metal-host-scripts-"));
    agent = join(work, "agent.mjs");
    await writeFile(agent, AGENT_SOURCE);
    tokenFile = join(work, "callback-token");
    await writeFile(tokenFile, callbackToken + "\n", { mode: 0o600 });
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("every script parses with bash -n", async () => {
    for (const script of SCRIPTS) {
      await expect(run("bash", ["-n", script]), script).resolves.toBeDefined();
    }
  });

  it("restarts hostd after a TLS renewal and only records a certificate after a healthy restart", async () => {
    const fixture = await mkdtemp(join(work, "tls-renewal-"));
    const tls = join(fixture, "tls");
    await run("bash", [`${DIR}/matrix-hostd-tls`, tls, "host.example.test", "--smoke"]);
    const source = await readFile(`${DIR}/provision-host.sh`, "utf8");
    const restartAt = source.indexOf('if [ -n "$hostd_changed$units_changed');
    const end = source.indexOf('install -m 0644 /dev/null "$policy_marker"', restartAt);
    const start = source.lastIndexOf('# --- hostd service ---', restartAt);
    const restartSection = source.slice(start < 0 ? restartAt : start, end);
    const marker = join(fixture, "tls-loaded.sha256");
    const reprovision = (failRestart = false) => run("bash", ["-euc", `
      ETC_DIR="$1" STATE_DIR="$1"
      fail_restart="$2"
      hostd_changed="" units_changed="" api_port=8443
      sha256_of() { sha256sum "$1" | awk '{print $1}'; }
      write_file() { cat >"$1"; }
      has() { return 0; }
      systemctl() {
        if [ "$1" = restart ]; then
          [ "$fail_restart" = false ] || return 1
          printf '%s\\n' "$2"
        fi
      }
      ${restartSection}
    `, "--", fixture, String(failRestart)]);

    const original = createHash("sha256").update(await readFile(join(tls, "cert.pem"))).digest("hex") + "\n";
    await writeFile(marker, original);
    await expect(reprovision()).resolves.toMatchObject({ stdout: "" });
    await run("openssl", ["req", "-x509", "-key", join(tls, "key.pem"), "-days", "60",
      "-subj", "/CN=host.example.test", "-out", join(tls, "cert.pem")]);
    await run("bash", [`${DIR}/matrix-hostd-tls`, tls, "host.example.test"]);
    await expect(reprovision(true)).rejects.toMatchObject({ code: 1 });
    expect(await readFile(marker, "utf8")).toBe(original);
    await expect(reprovision()).resolves.toMatchObject({ stdout: "matrix-hostd.service\n" });
    expect(await readFile(marker, "utf8")).not.toBe(original);
    await expect(reprovision()).resolves.toMatchObject({ stdout: "" });
  });

  // Reported as skipped (never silently passed) where shellcheck is not
  // installed; GitHub's ubuntu runners ship it, and $SHELLCHECK can point at one.
  it.skipIf(findShellcheck() === null)("every script passes shellcheck", async () => {
    await expect(run(findShellcheck()!, ["--severity=style", "--shell=bash", "-x", ...SCRIPTS])).resolves.toBeDefined();
  });

  it("never pipes into grep -q, which pipefail turns into a false miss", async () => {
    // A SIGPIPE'd `nft list ... | grep -q` once read as "no ruleset", chose the
    // default-deny firewall and locked a shared host out of SSH.
    for (const script of SCRIPTS) {
      const code = (await readFile(script, "utf8")).split("\n").filter((line) => !line.trim().startsWith("#"));
      expect(code.filter((line) => /\|\s*grep\s+-[a-zA-Z]*q/.test(line)), script).toEqual([]);
    }
  });

  it("arms a revert on every firewall change and checks SSH before loading", async () => {
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    // Every firewall load from provisioning goes through arm (marker + revert timer;
    // its behaviour is tested below), after the dry run (render, SSH check, nft -c).
    expect(provision).not.toMatch(/systemctl (re)?start[^\n]*matrix-hostd-nft\.service/);
    const dryRun = provision.indexOf('"$SCRIPT_DIR/matrix-hostd-nft" check');
    expect(dryRun).toBeGreaterThan(0);
    expect(dryRun).toBeLessThan(provision.indexOf("/usr/local/libexec/matrix-hostd-nft arm"));
    expect(provision).toContain("--confirm-firewall");
    const helper = await readFile(`${DIR}/matrix-hostd-nft`, "utf8");
    const apply = helper.slice(helper.indexOf("  apply)"));
    expect(apply.indexOf("check_ssh")).toBeLessThan(apply.indexOf('nft -f "$RENDERED"'));
  });

  it("refuses a ruleset that would drop SSH on the public interface", async () => {
    const good = join(work, "good.nft");
    await writeFile(good, await renderNft());
    await expect(run("bash", [`${DIR}/matrix-hostd-nft`, "check", good, "--wan", "eno1"])).resolves.toBeDefined();
    // Same rules, but SSH only reachable after a drop, or on another interface.
    const reordered = (await renderNft()).replace('    iifname "eno1" tcp dport 22 accept\n', "").replace(
      '    iifname "brmx" drop\n',
      '    iifname "brmx" drop\n    iifname "eno1" tcp dport 22 accept\n',
    );
    const bad = join(work, "bad.nft");
    await writeFile(bad, reordered);
    await expect(run("bash", [`${DIR}/matrix-hostd-nft`, "check", bad, "--wan", "eno1"])).rejects.toBeDefined();
    await expect(run("bash", [`${DIR}/matrix-hostd-nft`, "check", good, "--wan", "eth9"])).rejects.toBeDefined();
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

  it("checks the local ingress without constructing a per-handle DNS name", async () => {
    const smoke = await readFile(`${DIR}/smoke-host.sh`, "utf8");
    expect(smoke).not.toMatch(/\$\{?handle\}?\.matrix-os\.com/);
    expect(smoke).toContain('"https://127.0.0.1:$ingress_port/health")" = 401');
    expect(smoke).toContain('ip -4 neigh show to "$vm_ip" dev "$bridge" nud permanent');
    expect(smoke).toContain("check_ingress_binding");
    expect(smoke).toContain(`sed -n 's/^MAC=//p' "$unit_env"`);
    expect(smoke).not.toContain("json_field mac");
    expect(await readFile("docs/dev/metal-hosts.md", "utf8")).toContain("https://app.matrix-os.com/vm/<handle>");
  });

  it("smoke proves the guest root filesystem grew into the 40 GiB disk", async () => {
    const smoke = await readFile(`${DIR}/smoke-host.sh`, "utf8");
    // Over the smoke's own support key, after the gateway is healthy, before suspend.
    expect(smoke).toMatch(/ssh -i "\$work\/support"[\s\S]{0,200}?"matrix-support@\$vm_ip"/);
    expect(smoke).toContain("df -B1 --output=size /");
    expect(smoke).toContain("$((38 * 1024 * 1024 * 1024))");
    const at = (needle: string) => smoke.indexOf(needle);
    expect(at("df -B1 --output=size /")).toBeGreaterThan(at("gateway healthy"));
    expect(at("df -B1 --output=size /")).toBeLessThan(at("# --- suspend / resume"));
  });

  it("never flushes the ruleset and only defines its own tables", async () => {
    for (const file of await allFiles(DIR)) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/flush\s+ruleset/);
    }
    const rules = await renderNft();
    const tables = [...rules.matchAll(/^table\s+(\S+)\s+(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(new Set(tables)).toEqual(new Set(["inet matrix_hostd"]));
    expect(rules).not.toContain("@");
    const input = chain(rules, "input");
    expect(input[0]).toBe("type filter hook input priority 0; policy drop;");
    // R9 inputs: public SSH (before any drop), tailnet, Headscale, STUN, API, ingress.
    const ssh = input.indexOf('iifname "eno1" tcp dport 22 accept');
    expect(ssh).toBeGreaterThan(0);
    expect(input.slice(0, ssh).filter((l) => l.endsWith(" drop") && l !== "ct state invalid drop")).toEqual([]);
    for (const rule of [
      "ct state established,related accept",
      'iifname "tailscale0" accept',
      "tcp dport 443 accept",
      "udp dport 3478 accept",
      "tcp dport 9443 accept",
      "tcp dport 8443 accept",
      'iifname "brmx" drop',
    ]) {
      expect(input).toContain(rule);
    }
    const forward = chain(rules, "forward");
    expect(forward[0]).toBe("type filter hook forward priority 0; policy drop;");
    expect(forward).toContain('iifname "tailscale0" oifname "brmx" accept');

    const tenant = await renderNft("nftables-tenant.conf");
    const tenantForward = chain(tenant, "forward");
    expect(tenantForward[0]).toBe("type filter hook forward priority -10; policy accept;");
    expect(tenantForward).toContain('iifname "brmx" tcp dport 25 drop');
    expect(tenantForward).toContain('iifname "brmx" oifname != "eno1" drop');
    expect(tenantForward.at(-1)).toBe('oifname "brmx" drop');
    expect(chain(tenant, "input").at(-1)).toBe('iifname "brmx" drop');
    expect(tenant).toMatch(/ip saddr 10\.78\.0\.0\/22 oifname "eno1" masquerade/);
  });

  it("keeps new outbound traffic of VM networks on other bridges working", async () => {
    const forward = chain(await renderNft(), "forward");
    // A host that already runs VMs on another bridge (virbr0, the S7 spike host):
    // their new connections to the internet pass; they still cannot reach brmx.
    const others = 'iifname != { "eno1", "brmx", "tailscale0" } oifname "eno1" accept';
    expect(forward).toContain(others);
    expect(forward.indexOf(others)).toBeGreaterThan(forward.indexOf('iifname "brmx" accept'));
    expect(forward.filter((l) => l.includes('oifname "brmx"'))).toEqual(['iifname "tailscale0" oifname "brmx" accept']);
  });

  it("shapes each VM tap to 50 Mbit/s and keeps the VMM unprivileged", async () => {
    const tap = await readFile(`${DIR}/matrix-vm-network`, "utf8");
    expect(tap).toMatch(/action police rate 50mbit/);
    expect(tap).toMatch(/protocol all .*action drop/);
    for (const unit of ["matrix-vm@.service", "matrix-vm-restore@.service"]) {
      const text = await readFile(`${DIR}/systemd/${unit}`, "utf8");
      expect(text, unit).toContain("ExecStartPre=+/usr/local/libexec/matrix-vm-network start");
      expect(text, unit).toMatch(/^User=matrix-vm$/m);
      expect(text, unit).not.toMatch(/AmbientCapabilities/);
      expect(text, unit).toMatch(/RequiresMountsFor=\/var\/lib\/matrix-hostd\/snapshots/);
    }
  });

  it("reserves physical thin-pool space for the full size of admitted volumes", async () => {
    const bin = join(work, "thin-bin");
    const log = join(work, "thin-commands");
    await run("mkdir", ["-p", bin]);
    await writeFile(join(bin, "lvs"), '#!/bin/bash\nprintf "%s\\n" "$FAKE_LVS"\n', { mode: 0o755 });
    await writeFile(join(bin, "thin_metadata_size"), '#!/bin/bash\nprintf "1048576\\n"\n', { mode: 0o755 });
    for (const tool of ["lvcreate", "lvextend"]) {
      await writeFile(join(bin, tool), `#!/bin/bash\n echo "${tool} $*" >>"$FAKE_THIN_LOG"\n`, { mode: 0o755 });
    }
    const GiB = 1024 ** 3;
    const vols = [
      { lv_name: "pool", lv_size: 100 * GiB, segtype: "thin-pool", data_percent: "12.5", metadata_percent: "1.00",
        chunk_size: 65_536, lv_metadata_size: 2 * GiB },
      { lv_name: "golden-v1", lv_size: 20 * GiB, pool_lv: "pool", segtype: "thin" },
      { lv_name: "hostd-snapshots", lv_size: 40 * GiB, pool_lv: "pool", segtype: "thin" },
    ];
    const env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      MATRIX_HOSTD_THIN_LOCK: join(work, "thin.lock"),
      FAKE_THIN_LOG: log,
      FAKE_LVS: JSON.stringify({ report: [{ lv: vols }] }),
    };
    const allocate = (size: string) => run("python3", ["-I", `${DIR}/matrix-hostd-thin`,
      "clone", "vmvg", "pool", "85", "80", "mx-vm_test", size, "golden-v1",
    ], { env });

    await expect(allocate("40G")).rejects.toMatchObject({ code: 75 });
    expect(existsSync(log)).toBe(false);
    await expect(allocate("25G")).resolves.toBeDefined();
    expect(await readFile(log, "utf8")).toContain("lvextend --size 25G vmvg/mx-vm_test");
  });

  it("installs lvm2 before provisioning touches storage", async () => {
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    const packages = /for pkg in ([^;]+); do/.exec(provision)?.[1]?.split(/\s+/) ?? [];
    expect(packages).toContain("lvm2");
    expect(provision.indexOf("for pkg in")).toBeLessThan(provision.indexOf("pvcreate"));
  });

  it("formats a swap LV left unformatted by an interrupted run, checked apart from the LV's existence", async () => {
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    const swap = provision.slice(provision.indexOf("# Swap is a plain (thick) LV"), provision.indexOf("matrix-hostd-zswap.conf"));
    const create = swap.slice(0, swap.indexOf("\nfi\n"));
    // Creating the LV does not format it; the signature check that follows does.
    expect(create).toContain("lvcreate");
    expect(create).not.toContain("mkswap");
    const signature = swap.indexOf('blkid -p -s TYPE -o value "$swap_dev"');
    expect(signature).toBeGreaterThan(swap.indexOf("lvcreate"));
    expect(swap.indexOf("mkswap -L hostd-swap")).toBeGreaterThan(signature);
    expect(swap.indexOf("mkswap -L hostd-swap")).toBeLessThan(swap.indexOf("swapon --priority"));
    // Never formats over another signature.
    expect(swap).toMatch(/\*\) die "[^"]*not swap/);
  });

  it("holds a host-wide lock from before any golden build check or cleanup until the process exits", async () => {
    const build = await readFile(`${DIR}/build-golden-disk.sh`, "utf8");
    const lock = build.indexOf("flock --nonblock 9");
    expect(lock).toBeGreaterThan(0);
    expect(build).toMatch(/exec 9>"?\$LOCK_FILE"?/);
    // Before the already-built check, the first cleanup, and the EXIT trap.
    expect(lock).toBeLessThan(build.indexOf('if [ -n "$(lv_attr "$golden")" ]; then'));
    expect(lock).toBeLessThan(build.indexOf("# A previous run that died mid-way"));
    expect(lock).toBeLessThan(build.indexOf("trap cleanup EXIT"));
  });

  it("seals the golden read-only with its metadata before giving it the final name", async () => {
    const build = await readFile(`${DIR}/build-golden-disk.sh`, "utf8");
    const seal = build.slice(build.indexOf("# --- seal"));
    const readOnly = seal.indexOf('lvchange --quiet --permission r "$VG/$building"');
    const metadata = seal.indexOf('"$meta"');
    const rename = seal.indexOf('lvrename "$VG" "$building" "$golden"');
    expect(readOnly).toBeGreaterThan(0);
    expect(metadata).toBeGreaterThan(readOnly);
    expect(rename).toBeGreaterThan(metadata);
    expect(seal.indexOf("succeeded=1")).toBeGreaterThan(rename);
    // A finished golden needs its metadata; a failed run leaves none behind.
    const done = build.slice(build.indexOf('if [ -n "$(lv_attr "$golden")" ]; then'), build.indexOf("stop_vm_units() {"));
    expect(done).toContain('[ -f "$meta" ]');
    const cleanup = build.slice(build.indexOf("cleanup() {"), build.indexOf("trap cleanup EXIT"));
    expect(cleanup).toContain('rm -f -- "$meta"');
  });

  it("removes the golden build directory unless asked to keep a failed build", async () => {
    const build = await readFile(`${DIR}/build-golden-disk.sh`, "utf8");
    const cleanup = build.slice(build.indexOf("cleanup() {"), build.indexOf("trap cleanup EXIT"));
    expect(cleanup).toContain('rm -rf -- "$work"');
    expect(cleanup.indexOf("keep_on_failure")).toBeLessThan(cleanup.indexOf('rm -rf -- "$work"'));
  });

  it("renders the unchanged golden builder cloud-init plus the S7 guest settings", async () => {
    const build = await readFile(`${DIR}/build-golden-disk.sh`, "utf8");
    expect(build).toContain('--callback-token-file "$work/callback-token"');
    expect(build).not.toContain('--var "callbackToken=');
    const out = join(work, "builder.mime");
    await run("python3", [
      "-I", `${DIR}/render-user-data.py`, "builder",
      "--template", "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml",
      "--guest-dir", `${DIR}/guest`,
      "--guest-agent", agent,
      "--callback-token-file", tokenFile,
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
    expect(rendered).toContain(callbackToken);
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
    // hostd lvextends a clone past the golden size; every boot of the clone must
    // grow the root partition and filesystem into it.
    expect(stdout).toContain("/etc/cloud/cloud.cfg.d/90-matrix-grow-root.cfg");
    expect(stdout).toMatch(/growpart:\n {2}mode: auto\n {2}devices: \['\/'\]\nresize_rootfs: true/);
    // The customer cloud-init runs `sshd -t` before sshd's socket ever fired.
    expect(stdout).toContain("d /run/sshd 0755 root root -");
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
        "--callback-token-file", tokenFile,
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

// The firewall dead-man switch, driven through matrix-hostd-nft's real
// arm/guard/confirm commands against a fake systemd that keeps unit state in
// files. Faults it catches: a firewall that comes back with no revert after a
// reboot or a hostd restart (the unit enabled before confirmation, or a lost
// transient timer), and a confirm that claims success after the revert fired.
describe("metal host firewall revert", () => {
  const NFT = "distro/metal-host/matrix-hostd-nft";
  const FW = "matrix-hostd-nft.service";
  const TIMER = "matrix-hostd-nft-revert.timer";
  let dir: string;
  let state: string;
  let marker: string;
  let env: NodeJS.ProcessEnv;

  const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >>"$FAKE_STATE/log"
args=(); for a in "$@"; do case "$a" in --quiet|--no-block) ;; *) args+=("$a") ;; esac; done
verb="\${args[0]}"; now=0
case "$verb" in
  is-active) [ -e "$FAKE_STATE/active-\${args[1]}" ]; exit ;;
  is-enabled) [ -e "$FAKE_STATE/enabled-\${args[1]}" ]; exit ;;
  disable) [ "\${args[1]}" = --now ] && { now=1; unset 'args[1]'; args=("\${args[@]}"); }
    for u in "\${args[@]:1}"; do rm -f "$FAKE_STATE/enabled-$u"; [ "$now" = 1 ] && rm -f "$FAKE_STATE/active-$u"; done ;;
  enable) for u in "\${args[@]:1}"; do : >"$FAKE_STATE/enabled-$u"; done ;;
  stop) for u in "\${args[@]:1}"; do rm -f "$FAKE_STATE/active-$u"; done ;;
  start|restart) for u in "\${args[@]:1}"; do
    # The firewall unit runs ExecStartPre=guard, then ExecStart=apply.
    if [ "$u" = matrix-hostd-nft.service ]; then
      bash "$FAKE_HELPER" guard && bash "$FAKE_HELPER" apply || { rm -f "$FAKE_STATE/active-$u"; exit 1; }
    fi
    : >"$FAKE_STATE/active-$u"; done ;;
esac
exit 0
`;
  const FAKE_NFT = `#!/usr/bin/env bash
printf 'nft %s\\n' "$*" >>"$FAKE_STATE/log"
`;
  const FAKE_SYSTEMD_RUN = `#!/usr/bin/env bash
printf 'systemd-run %s\\n' "$*" >>"$FAKE_STATE/log"
: >"$FAKE_STATE/active-${TIMER}"
`;

  const nft = (...args: string[]) =>
    run("bash", [NFT, ...args], { env }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }),
    );
  const has = (name: string) => existsSync(join(state, name));
  const log = async () => (existsSync(join(state, "log")) ? readFile(join(state, "log"), "utf8") : "");
  const setMarker = (ageSeconds: number) => writeFile(marker, `${Math.floor(Date.now() / 1000) - ageSeconds}\n`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metal-fw-"));
    const bin = join(dir, "bin");
    await run("mkdir", ["-p", bin]);
    await writeFile(join(bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
    await writeFile(join(bin, "systemd-run"), FAKE_SYSTEMD_RUN, { mode: 0o755 });
    await writeFile(join(bin, "nft"), FAKE_NFT, { mode: 0o755 });
    env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    state = await mkdtemp(join(dir, "state-"));
    marker = join(state, "firewall-unconfirmed");
    template = join(state, "nftables.conf");
    await writeFile(template, await readFile("distro/metal-host/nftables.conf", "utf8"));
    await writeFile(join(state, "nft.env"), "WAN=eno1\nINGRESS_PORT=9443\nAPI_PORT=8443\n");
    env = {
      ...env,
      FAKE_STATE: state,
      MATRIX_HOSTD_FIREWALL_MARKER: marker,
      MATRIX_HOSTD_FIREWALL_CONFIRMED: join(state, "firewall-confirmed.sha256"),
      MATRIX_HOSTD_FIREWALL_LOADED: join(state, "firewall-loaded.sha256"),
      FAKE_HELPER: join(process.cwd(), NFT),
      MATRIX_HOSTD_NFT_TEMPLATE: template,
      MATRIX_HOSTD_NFT_ENV: join(state, "nft.env"),
      MATRIX_HOSTD_NFT_RENDERED: join(state, "nftables.nft"),
    };
  });
  let template: string;
  const loads = async () => (await log()).split("\n").filter((l) => /^nft -f /.test(l)).length;
  // Brings the fake host to "confirmed firewall running and enabled".
  const confirmed = async () => {
    await nft("arm");
    const result = await nft("confirm");
    expect(result.code, result.out).toBe(0);
  };

  it("preserves loaded tenant rules when the management firewall reverts", async () => {
    const tenant = join(state, "tenant.nft");
    env.MATRIX_HOSTD_TENANT_NFT_TEMPLATE = join(process.cwd(), DIR, "nftables-tenant.conf");
    env.MATRIX_HOSTD_TENANT_NFT_RENDERED = tenant;

    const applied = await nft("apply-tenant");
    expect(applied.code, applied.out).toBe(0);
    expect(await readFile(tenant, "utf8")).toContain("table inet matrix_hostd_tenant");
    expect(await readFile(tenant, "utf8")).toContain("table ip matrix_hostd_nat");
    expect((await nft("remove")).code).toBe(0);
    expect((await log()).split("\n").filter((line) => line.includes("nft delete table"))).toEqual([
      "nft delete table inet matrix_hostd",
    ]);
  });

  it("arm starts the firewall unenabled, with a marker and a revert timer", async () => {
    await writeFile(join(state, `enabled-${FW}`), "");
    const result = await nft("arm");
    expect(result.code, result.out).toBe(0);
    expect(has(`active-${FW}`)).toBe(true);
    // Never enabled before confirmation: a reboot must not bring it back.
    expect(has(`enabled-${FW}`)).toBe(false);
    expect(has(`active-${TIMER}`)).toBe(true);
    expect(await log()).toMatch(/systemd-run .*--unit matrix-hostd-nft-revert --on-active=600 .*systemctl disable --now matrix-hostd-nft\.service/);
    const stamp = Number((await readFile(marker, "utf8")).trim());
    expect(Math.abs(stamp - Date.now() / 1000)).toBeLessThan(5);
  });

  it("guard lets a fresh or absent marker through and fails open on a stale one", async () => {
    expect((await nft("guard")).code).toBe(0);
    await setMarker(60);
    expect((await nft("guard")).code).toBe(0);
    // A revert timer lost on reboot: the unit must refuse to load the rules.
    await setMarker(601);
    const stale = await nft("guard");
    expect(stale.code).not.toBe(0);
    expect(stale.out).toMatch(/not confirmed/i);
    await writeFile(marker, "garbage\n");
    expect((await nft("guard")).code).not.toBe(0);
  });

  it("confirm enables the firewall, cancels the revert and clears the marker", async () => {
    await nft("arm");
    const result = await nft("confirm");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/confirmed/);
    expect(has(`enabled-${FW}`)).toBe(true);
    expect(has(`active-${TIMER}`)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("confirm fails loudly when the revert already happened", async () => {
    await nft("arm");
    // The timer fired: firewall stopped and disabled; the marker stays.
    await rm(join(state, `active-${FW}`));
    await rm(join(state, `active-${TIMER}`));
    const fired = await nft("confirm");
    expect(fired.code).not.toBe(0);
    expect(fired.out).toMatch(/re-run provision/i);
    expect(has(`enabled-${FW}`)).toBe(false);
    // Stale marker with the unit somehow still running is also not confirmable.
    await writeFile(join(state, `active-${FW}`), "");
    await setMarker(900);
    expect((await nft("confirm")).code).not.toBe(0);
    expect(has(`enabled-${FW}`)).toBe(false);
  });

  it("confirm with nothing pending only succeeds for an already confirmed firewall", async () => {
    expect((await nft("confirm")).code).not.toBe(0);
    await writeFile(join(state, `active-${FW}`), "");
    await writeFile(join(state, `enabled-${FW}`), "");
    const confirmed = await nft("confirm");
    expect(confirmed.code).toBe(0);
    expect(confirmed.out).toMatch(/already confirmed/);
  });

  it("confirm records the fingerprint of the confirmed rules and helper", async () => {
    await confirmed();
    expect((await nft("changed")).code).not.toBe(0);
    expect((await readFile(join(state, "firewall-confirmed.sha256"), "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/);
    // The confirmed ruleset reloads fine with no window open.
    const before = await loads();
    const result = await nft("apply");
    expect(result.code, result.out).toBe(0);
    expect(await loads()).toBe(before + 1);
  });

  it("a run that died after installing new rules never loads them unconfirmed", async () => {
    await confirmed();
    // The failed run: the new template is on disk, nothing was armed.
    await writeFile(template, (await readFile(template, "utf8")).replace("udp dport 41641 accept", "udp dport 41642 accept"));
    // A reboot (the unit is enabled) or a reload refuses the unconfirmed rules.
    const before = await loads();
    const reboot = await nft("apply");
    expect(reboot.code).not.toBe(0);
    expect(reboot.out).toMatch(/not confirmed/i);
    expect(await loads()).toBe(before);
    // The retry sees the change and arms instead of reloading.
    expect((await nft("changed")).code).toBe(0);
    await nft("arm");
    expect(existsSync(marker)).toBe(true);
    expect(has(`active-${TIMER}`)).toBe(true);
    expect(has(`enabled-${FW}`)).toBe(false);
    // arm's restart loaded the new rules.
    expect(await loads()).toBe(before + 1);
  });

  it("confirm refuses rules on disk that differ from the ones loaded", async () => {
    await confirmed();
    // A new window: arm loads rules A.
    await writeFile(template, (await readFile(template, "utf8")).replace("udp dport 41641 accept", "udp dport 41642 accept"));
    expect((await nft("arm")).code).toBe(0);
    // A re-run with other settings installs rules B, then dies before arming.
    await writeFile(template, (await readFile(template, "utf8")).replace("udp dport 41642 accept", "udp dport 41643 accept"));
    const result = await nft("confirm");
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/not the ones loaded/i);
    expect(has(`enabled-${FW}`)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    // The refused confirm leaves the revert armed: waiting out the window still
    // restores access if the loaded rules block it.
    expect(has(`active-${TIMER}`)).toBe(true);
    // Confirming what is actually loaded still works once the files match it again.
    await writeFile(template, (await readFile(template, "utf8")).replace("udp dport 41643 accept", "udp dport 41642 accept"));
    expect((await nft("confirm")).code).toBe(0);
    expect(has(`enabled-${FW}`)).toBe(true);
  });

  it("parameter changes and a missing confirmation record also count as changed", async () => {
    expect((await nft("changed")).code).toBe(0);
    await confirmed();
    await writeFile(join(state, "nft.env"), "WAN=eno1\nINGRESS_PORT=443\nAPI_PORT=8443\n");
    expect((await nft("changed")).code).toBe(0);
  });

  it("requires tenant rules for the hostd and both VM units", async () => {
    for (const name of ["matrix-hostd.service", "matrix-vm@.service", "matrix-vm-restore@.service"]) {
      const unit = await readFile(`${DIR}/systemd/${name}`, "utf8");
      expect(unit).toMatch(/^BindsTo=.*matrix-hostd-tenant-nft\.service/m);
      expect(unit).toMatch(/^After=.*matrix-hostd-tenant-nft\.service/m);
    }
  });

  it("keeps tenant rules in the same nftables transaction on system reload and restart", async () => {
    const dropInPath = "systemd/nftables.service.d/60-matrix-hostd.conf";
    const wrapper = "/usr/local/share/matrix-hostd/system-nftables.nft";
    const dropIn = await readFile(`${DIR}/${dropInPath}`, "utf8");
    const exec = `/usr/sbin/nft -f ${wrapper}`;
    expect(dropIn.match(/^ExecStart=.*$/gm)).toEqual(["ExecStart=", `ExecStart=${exec}`]);
    expect(dropIn.match(/^ExecReload=.*$/gm)).toEqual(["ExecReload=", `ExecReload=${exec}`]);
    // The stock stop action flushes every table before ExecStart can run.
    expect(dropIn.match(/^ExecStop=.*$/gm)).toEqual(["ExecStop="]);
    const rules = await readFile(`${DIR}/system-nftables.nft`, "utf8");
    expect(rules.match(/^include .*$/gm)).toEqual([
      'include "/etc/nftables.conf"',
      'include "/etc/matrix-hostd/nftables-tenant.nft"',
    ]);
    const provision = await readFile(`${DIR}/provision-host.sh`, "utf8");
    const installWrapper = provision.indexOf(`install_file "$SCRIPT_DIR/system-nftables.nft" ${wrapper}`);
    const tenantLoad = provision.indexOf("systemctl reload-or-restart matrix-hostd-tenant-nft.service");
    const installDropIn = provision.indexOf(`install_file "$SCRIPT_DIR/${dropInPath}"`);
    expect(installWrapper).toBeGreaterThan(-1);
    expect(tenantLoad).toBeGreaterThan(installWrapper);
    expect(installDropIn).toBeGreaterThan(tenantLoad);
    expect(provision.indexOf("systemctl daemon-reload", installDropIn)).toBeGreaterThan(installDropIn);
  });

  it("wires the units so only a confirmed firewall survives reboot or hostd restarts", async () => {
    const hostd = await readFile("distro/metal-host/systemd/matrix-hostd.service", "utf8");
    expect(hostd).not.toMatch(/^(Wants|Requires|BindsTo)=.*matrix-hostd-nft/m);
    expect(hostd).toMatch(/^After=.*matrix-hostd-nft\.service/m);
    const unit = await readFile("distro/metal-host/systemd/matrix-hostd-nft.service", "utf8");
    expect(unit).toMatch(/^ExecStartPre=\/usr\/local\/libexec\/matrix-hostd-nft guard$/m);
    const provision = await readFile("distro/metal-host/provision-host.sh", "utf8");
    // provision never enables the firewall itself; only confirm does.
    expect(provision).not.toMatch(/systemctl enable[^\n]*matrix-hostd-nft/);
    expect(provision).toContain("matrix-hostd-nft confirm");
    expect(provision).toContain("matrix-hostd-nft arm");
    // Change detection is the rendered rules + helper against the confirmed
    // fingerprint, and the new files are installed only in the firewall step.
    expect(provision).toContain("/usr/local/libexec/matrix-hostd-nft changed");
    const firewallStep = provision.indexOf("# --- firewall ---");
    for (const file of ['install_file "$SCRIPT_DIR/matrix-hostd-nft"', 'install_file "$SCRIPT_DIR/nftables.conf"']) {
      expect(provision.indexOf(file)).toBeGreaterThan(firewallStep);
    }
  });
});
