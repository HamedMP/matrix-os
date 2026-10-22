import { spawnSync } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const pool = resolve(import.meta.dirname, "../../scripts/ci/runner-pool/pool.sh");
const dockerfile = readFileSync(resolve(import.meta.dirname, "../../scripts/ci/runner-pool/Dockerfile"), "utf8");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "runner-pool-"));
  dirs.push(dir);
  const key = join(dir, "app.pem");
  spawnSync("openssl", ["genrsa", "-out", key, "2048"], { stdio: "ignore" });
  const bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("hostname", "echo host");
  fake("timeout", 'shift 2; exec "$@"');
  fake("docker", `echo "docker $*" >> "${dir}/calls"; [ "$1" != run ] || exit "\${FAKE_DOCKER_STATUS:-0}"`);
  fake(
    "curl",
    `args="$*"; body=""; [[ "$args" == *"@-"* ]] && body=$(cat)
echo "curl $args $body" >> "${dir}/calls"
[ -z "\${FAKE_CURL_FAIL:-}" ] || exit 22
case "$args" in
  *access_tokens*) echo '{"token":"installation-token"}' ;;
  *generate-jitconfig*) echo '{"encoded_jit_config":"jit-config"}' ;;
  *"runners?per_page"*) echo '{"runners":[{"id":5,"name":"matrix-ci-host-1-9","status":"offline"},{"id":6,"name":"matrix-ci-host-2-9","status":"offline"},{"id":7,"name":"matrix-ci-host-1-8","status":"online"}]}' ;;
  *) echo '{}' ;;
esac`,
  );
  const run = (script: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `source "${pool}"; ${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MATRIX_CI_POOL_SKIP_CONFIG: "1",
        APP_ID: "4242",
        INSTALLATION_ID: "77",
        APP_KEY_FILE: key,
        ...env,
      },
    });
  const calls = () => readFileSync(join(dir, "calls"), "utf8");
  return { key, run, calls };
}

describe("runner pool", () => {
  it("signs a GitHub App JWT the App's public key verifies", () => {
    const { key, run } = sandbox();
    const result = run("app_jwt");
    expect(result.status, result.stderr).toBe(0);
    const [header, payload, signature] = result.stdout.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(readFileSync(key)), Buffer.from(signature, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("4242");
    expect(claims.exp - claims.iat).toBe(600);
  });

  it("pins each slot to its own CPU range", () => {
    const { run } = sandbox();
    expect(run("cpuset_for 1; echo; cpuset_for 4").stdout).toBe("0-7\n24-31");
    expect(run("cpuset_for 2", { SLOT_CPUS: "15" }).stdout).toBe("15-29");
  });

  it("runs one isolated container per job with a single-use JIT config", () => {
    const { run, calls } = sandbox();
    const result = run("run_one_job 1");
    expect(result.status, result.stderr).toBe(0);
    const log = calls();
    expect(log).toContain('"labels":["matrix-ci"]');
    expect(log).toContain("/repos/HamedMP/matrix-os/actions/runners/generate-jitconfig");
    // Only this slot's offline registration is removed.
    expect(log).toContain("DELETE -H Authorization: Bearer installation-token");
    expect(log).toMatch(/actions\/runners\/5\b/);
    expect(log).not.toMatch(/actions\/runners\/[67]\b/);
    const dockerRun = log.split("\n").find((line) => line.startsWith("docker run"));
    expect(dockerRun).toContain("--rm --name matrix-ci-slot-1 --network matrix-ci-pool --cpuset-cpus 0-7 --memory 28g");
    expect(dockerRun).toContain("RUNNER_JIT=jit-config matrix-ci-runner:current");
    for (const forbidden of ["--privileged", "docker.sock", "-v ", "--volume", "--network host"]) {
      expect(dockerRun).not.toContain(forbidden);
    }
  });

  it("reports API and Docker failures so the slot backs off", () => {
    expect(sandbox().run("run_one_job 1", { FAKE_CURL_FAIL: "1" }).status).not.toBe(0);
    expect(sandbox().run("run_one_job 1", { FAKE_DOCKER_STATUS: "125" }).status).toBe(125);
  });

  it("publishes the heartbeat variable CI routes on", () => {
    const { run, calls } = sandbox();
    expect(run("publish_heartbeat").status).toBe(0);
    // Only this host's online, idle runners count; the fixture has one online runner and no busy flag.
    const patch = calls().split("\n").find((line) => line.includes("PATCH"));
    expect(patch).toContain("/actions/variables/MATRIX_CI_POOL_HEARTBEAT");
    expect(patch).toMatch(/"value":"[0-9]+ 1"/);
  });

  it("keeps job containers behind the egress firewall", () => {
    const dir = resolve(import.meta.dirname, "../../scripts/ci/runner-pool");
    const firewall = readFileSync(join(dir, "firewall.sh"), "utf8");
    for (const cidr of ["10.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"]) {
      expect(firewall).toContain(cidr);
    }
    expect(firewall).toContain('iptables -I INPUT 1 -i "$bridge" -j REJECT');
    expect(readFileSync(join(dir, "matrix-ci-pool-slot@.service"), "utf8")).toMatch(/^Requires=.*matrix-ci-pool-firewall\.service$/m);
    expect(readFileSync(join(dir, "install.sh"), "utf8")).toContain("com.docker.network.bridge.name=matrix-ci-pool0 matrix-ci-pool");
  });

  it("pins the runner base image by digest", () => {
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/actions\/actions-runner:[0-9.]+@sha256:[a-f0-9]{64}$/m);
  });
});
