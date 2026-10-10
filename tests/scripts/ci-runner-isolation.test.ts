import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve("scripts/ci/runner");
const sha = "a".repeat(40);

function readOptionalEvidence(read: () => string): string {
  try { return read(); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.debug("Expected benchmark evidence was not created");
      return "";
    }
    console.error("Unexpected benchmark evidence read failure", error);
    throw error;
  }
}

function invoke(args: string[], failure: boolean | "firewall" | "artifact" | "timeout" | "read" = false, hostCores = 16) {
  const dir = mkdtempSync(resolve(tmpdir(), "matrix-runner-test-"));
  const log = resolve(dir, "calls");
  writeFileSync(resolve(dir, "nproc"), `#!/bin/bash\necho ${hostCores}\n`);
  chmodSync(resolve(dir, "nproc"), 0o755);
  writeFileSync(resolve(dir, "docker"), `#!/bin/bash
[[ "$FAIL_READ" != 1 ]] || mkdir -p "$CALLS"
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == create ]]; then echo test-container; fi
if [[ "$1" == exec && "$FAIL_TIMEOUT" == 1 ]]; then exit 124; fi
if [[ "$1" == exec && "$FAIL_START" == 1 ]]; then exit 42; fi
if [[ "$1" == cp ]]; then
  [[ "$FAIL_ARTIFACT" != 1 ]] || exit 1
  python3 - "\${2##*/}" <<'PYTAR'
import io,sys,tarfile
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
    entry=tarfile.TarInfo(sys.argv[1]);entry.size=4
    archive.addfile(entry,io.BytesIO(b'unit'))
PYTAR
fi
`);
  chmodSync(resolve(dir, "docker"), 0o755);
  writeFileSync(resolve(dir, "flock"), "#!/bin/bash\nexit 0\n");
  chmodSync(resolve(dir, "flock"), 0o755);
  writeFileSync(resolve(dir, "timeout"), '#!/bin/bash\nshift 3\nexec "$@"\n');
  chmodSync(resolve(dir, "timeout"), 0o755);
  writeFileSync(resolve(dir, "iptables"), '#!/bin/bash\n[[ "$FAIL_FIREWALL" != 1 ]]\n');
  chmodSync(resolve(dir, "iptables"), 0o755);
  try {
    const result = spawnSync("bash", [resolve(root, "start-ephemeral.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: log,
        FAIL_READ: failure === "read" ? "1" : "0", FAIL_TIMEOUT: failure === "timeout" ? "1" : "0", FAIL_START: failure === true ? "1" : "0", FAIL_ARTIFACT: failure === "artifact" ? "1" : "0", FAIL_FIREWALL: failure === "firewall" ? "1" : "0", MATRIX_CI_STATE_DIR: dir },
    });
    const resultsDir = resolve(dir, "results");
    const persistedStatus = readOptionalEvidence(() => readFileSync(resolve(resultsDir, readdirSync(resultsDir)[0], "exit-code"), "utf8").trim());
    return { result, persistedStatus, calls: readOptionalEvidence(() => readFileSync(log, "utf8")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("disposable manual CI benchmark admission and isolation", () => {
  it.each([["main", "unit", "8"], [sha, "unit;id", "8"], [sha, "unit", "17"], [sha, "unit", "0"]])(
    "rejects invalid request before allocating a container: %s %s %s", (...args) => {
      const { result, calls } = invoke(args);
      expect(result.status).not.toBe(0);
      expect(calls).toBe("");
    },
  );
  it("surfaces unexpected test evidence read failures", () => {
    expect(() => invoke([sha, "unit", "8"], "read")).toThrow();
  });
  it("runs a reviewed immutable SHA as nonroot with bounded resources and no host mounts", () => {
    const { result, calls } = invoke([sha, "unit", "8"]);
    expect(result.status).toBe(0);
    const create = calls.split("\n").find((line) => line.startsWith("create "))!;
    expect(create).toContain("--init");
    expect(create).toContain("--user 10001:10001");
    expect(create).toContain("--cap-drop ALL");
    expect(create).toContain("--security-opt no-new-privileges:true");
    expect(create).toContain("--cpus 16");
    expect(create).toContain("--memory 56g");
    expect(create).toContain("--memory-swap 56g");
    expect(create).toContain("--pids-limit 4096");
    expect(create).toContain("--network matrix-ci");
    expect(create).not.toMatch(/--privileged|--volume|--mount|--network host|docker\.sock/);
    expect(calls).toContain(`exec --user 10001:10001 test-container /opt/matrix-ci/benchmark.sh ${sha} unit 8`);
    expect(calls).toContain("rm --force test-container");
  });
  it("fits an eight-core host with a bounded 28-GB container", () => {
    const { result, calls } = invoke([sha, "unit", "8"], false, 8);
    expect(result.status).toBe(0);
    const create = calls.split("\n").find((line) => line.startsWith("create "))!;
    expect(create).toContain("--cpus 8 --memory 28g --memory-swap 28g");
    expect(create).toContain("/work:rw,exec,nosuid,nodev,size=16g");
  });
  it("rejects undersized hosts before container allocation", () => {
    const { result, calls } = invoke([sha, "unit", "8"], false, 4);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain("create ");
  });
  it("bounds every writable container path without using host disk", () => {
    const { result, calls } = invoke([sha, "unit", "8"]);
    expect(result.status).toBe(0);
    const create = calls.split("\n").find((line) => line.startsWith("create "))!;
    expect(create).toContain("--read-only");
    expect(create).toContain("--tmpfs /work:rw,exec,nosuid,nodev,size=32g,uid=10001,gid=10001,mode=0755");
    expect(create).toContain("--tmpfs /tmp:rw,exec,nosuid,nodev,size=2g,mode=1777");
    expect(create).toContain("--tmpfs /home/runner:rw,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755");
    const image = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(image).toContain("HOME=/home/runner");
    expect(image).toContain("XDG_CACHE_HOME=/work/cache");
    expect(image).toContain("XDG_DATA_HOME=/work/share");
    expect(image).toContain("npm_config_store_dir=/work/pnpm-store");
  });
  it("collects tmpfs artifacts before stopping the trusted keepalive container", () => {
    const { result, calls } = invoke([sha, "unit", "8"]);
    expect(result.status).toBe(0);
    const execute = calls.indexOf("exec --user 10001:10001 test-container");
    const copy = calls.indexOf("cp test-container:/work/results/unit-cold.json -");
    const remove = calls.indexOf("rm --force test-container");
    expect(execute).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(execute);
    expect(remove).toBeGreaterThan(copy);
    expect(calls).not.toContain("wait test-container");
    expect(readFileSync(resolve(root, "Dockerfile"), "utf8")).toContain('ENTRYPOINT ["/usr/bin/sleep", "2100"]');
  });
  it("fails closed when a successful benchmark has no accepted timing evidence", () => {
    const { result, calls, persistedStatus } = invoke([sha, "unit", "8"], "artifact");
    expect(result.status).toBe(70);
    expect(persistedStatus).toBe("70");
    expect(calls).toContain("rm --force test-container");
  });
  it("stops timed-out benchmark processes before collecting artifacts", () => {
    const { result, calls } = invoke([sha, "unit", "8"], "timeout");
    expect(result.status).toBe(124);
    expect(calls).toContain("rm --force test-container");
    expect(calls).not.toContain("cp test-container:");
  });
  it("propagates job failures and removes the container", () => {
    const { result, calls } = invoke([sha, "unit", "8"], true);
    expect(result.status).toBe(42);
    expect(calls).toContain("rm --force test-container");
  });
  it("never registers an open GitHub runner or accepts a registration token", () => {
    const script = readFileSync(resolve(root, "start-ephemeral.sh"), "utf8");
    expect(script).not.toMatch(/config\.sh|run\.sh|--token|jitconfig|actions\/runners/);
    expect(invoke([sha, "github-runner", "8"]).calls).toBe("");
  });
  it("pins toolchain downloads, verifies checksums, and drops root in the image", () => {
    const image = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(image).toMatch(/FROM ubuntu:24\.04@sha256:[a-f0-9]{64}/);
    expect(image).toContain("node-v24.21.0-linux-x64.tar.xz");
    expect(image).toContain("pnpm-10.33.4.tgz");
    expect(image).toContain("bun-v1.4.3");
    expect(image.match(/sha256sum -c/g)).toHaveLength(3);
    expect(image).toContain("USER 10001:10001");
  });
  it("checks immutable checkout and a frozen lockfile before executing suites", () => {
    const script = readFileSync(resolve(root, "benchmark.sh"), "utf8");
    expect(script).toContain('git rev-parse HEAD');
    expect(script).toContain('pnpm install --frozen-lockfile');
    expect(script).toContain('https://github.com/HamedMP/matrix-os.git');
    expect(script).not.toMatch(/eval |source \/|--with-deps|GITHUB_TOKEN|HETZNER/);
  });
  it("all shell entrypoints have valid syntax", () => {
    for (const file of ["start-ephemeral.sh", "benchmark.sh", "bootstrap-host.sh", "dispatch.sh", "install-dispatch.sh", "cleanup-host.sh"])
      expect(() => execFileSync("bash", ["-n", resolve(root, file)])).not.toThrow();
  });
  it.each(["run main unit", `run ${sha} unit;id`, `run ${sha} full extra`, "bash", "scp -t /tmp/file", `run ${sha} unit\nid`])(
    "forced SSH dispatch denies shell, injection, and transfer: %s", (command) => {
      const result = spawnSync("bash", [resolve(root, "dispatch.sh")], { encoding: "utf8", env: { ...process.env, SSH_ORIGINAL_COMMAND: command } });
      expect(result.status).toBe(64);
    },
  );
  it.each([[8, "8"], [16, "12"]])("forced SSH dispatch fits %s cores with fixed arguments", (cores, workers) => {
    const dir = mkdtempSync(resolve(tmpdir(), "matrix-dispatch-test-"));
    writeFileSync(resolve(dir, "nproc"), `#!/bin/bash\necho ${cores}\n`);
    chmodSync(resolve(dir, "nproc"), 0o755);
    writeFileSync(resolve(dir, "sudo"), '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    chmodSync(resolve(dir, "sudo"), 0o755);
    try {
      const result = spawnSync("bash", [resolve(root, "dispatch.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: `run ${sha} unit` } });
      expect(result.status).toBe(0);
      expect(result.stdout.split("\n")).toEqual(["--non-interactive", "--", "/usr/local/libexec/matrix-ci/start-ephemeral.sh", sha, "unit", workers, ""]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("requires the private-egress firewall before a container is created", () => {
    const script = readFileSync(resolve(root, "start-ephemeral.sh"), "utf8");
    expect(script.indexOf("iptables -C DOCKER-USER")).toBeLessThan(script.indexOf("docker create"));
    expect(script).toContain("iptables -C INPUT -i matrix-ci0 -j REJECT");
    const { result, calls } = invoke([sha, "unit", "8"], "firewall");
    expect(result.status).not.toBe(0);
    expect(calls).toBe("");
  });
  it("installs a restricted SSH key without Docker membership or persistent privileged runner", () => {
    const script = readFileSync(resolve(root, "install-dispatch.sh"), "utf8");
    expect(script).toContain('restrict,command="/usr/local/libexec/matrix-ci/dispatch.sh"');
    expect(script).toContain("ForceCommand /usr/local/libexec/matrix-ci/dispatch.sh");
    expect(script).toContain("AllowTcpForwarding no");
    expect(script.indexOf("PermitUserEnvironment no")).toBeLessThan(script.indexOf("Match User matrixci"));
    expect(script).not.toMatch(/usermod.*docker|docker\.sock|--privileged|--token/);
  });
  it("collects both cold and warm passes even after a test failure", () => {
    const script = readFileSync(resolve(root, "benchmark.sh"), "utf8");
    expect(script).toContain('run_suite "$pass" || failed=1');
    expect(script).toContain('exit "$failed"');
  });
  it("full benchmarks run bounded independent groups and wait for every result", () => {
    const script = readFileSync(resolve(root, "benchmark.sh"), "utf8");
    expect(script).toContain('suite=unit workers=$unit_workers run_suite "$pass" &');
    expect(script).toContain('suite=checks workers=2 run_suite "$pass" &');
    expect(script).toContain('wait "$pid" || failed=1');
    expect(script).toContain('--maxWorkers=2');
  });
  it("artifact extraction rejects symlinks, directories, and excess file sizes", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "matrix-artifact-test-"));
    try {
      const result = spawnSync("python3", ["-c", `
import io,tarfile,subprocess,sys
for kind in ['symlink','directory','oversize','valid']:
    buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w') as archive:
        entry=tarfile.TarInfo('timing.tsv')
        if kind=='symlink': entry.type=tarfile.SYMTYPE; entry.linkname='/etc/passwd'
        elif kind=='directory': entry.type=tarfile.DIRTYPE
        elif kind=='oversize': entry.size=51*1024*1024
        else: entry.size=4
        if kind=='valid': archive.addfile(entry,io.BytesIO(b'unit'))
        elif kind=='oversize': archive.fileobj.write(entry.tobuf())
        else: archive.addfile(entry)
    result=subprocess.run([sys.executable,sys.argv[1],sys.argv[2]+'/'+kind,'timing.tsv'],input=buf.getvalue(),capture_output=True)
    assert (result.returncode==0)==(kind=='valid'),(kind,result.stderr)
`, resolve(root, "copy-artifact.py"), dir], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(resolve(dir, "valid"), "utf8")).toBe("unit");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
