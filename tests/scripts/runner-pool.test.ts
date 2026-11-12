import { spawnSync } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  *"runners?per_page"*) echo '{"runners":[{"id":5,"name":"matrix-ci-host-1-9","status":"offline"},{"id":6,"name":"matrix-ci-host-2-9","status":"offline"},{"id":7,"name":"matrix-ci-host-1-8","status":"online"},{"id":8,"name":"matrix-ci-host-3-8","status":"online","busy":true},{"id":9,"name":"matrix-ci-other-1-8","status":"online"}]}' ;;
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
    // A fresh per-job work volume and an executable in-memory /tmp, never a host path. /tmp must be
    // tmpfs: the collaboration identity code rejects ext4 under a container's seccomp filter.
    expect(dockerRun).toContain("--mount type=volume,dst=/home/runner/_work --tmpfs /tmp:rw,exec,nosuid,size=12g,mode=1777");
    expect(log).toContain("docker rm -f -v matrix-ci-slot-1");
    expect(dockerfile).toContain("mkdir -p /home/runner/_work && chown runner:runner /home/runner/_work");
    for (const forbidden of ["--privileged", "docker.sock", "-v ", "--volume", "--network host", "type=bind", "src=", "source="]) {
      expect(dockerRun).not.toContain(forbidden);
    }
    expect(dockerRun).toContain("--cap-drop NET_RAW --sysctl net.ipv6.conf.all.disable_ipv6=1");
    // The token request names one repository and only the permissions the pool uses.
    const token = log.split("\n").find((line) => line.includes("access_tokens"));
    expect(token).toContain('{"repositories":["matrix-os"],"permissions":{"administration":"write","actions_variables":"write"}}');
  });

  // Process tree: outer Runner.Listener (stands in for the CI runner hosting this suite) -> plain
  // bash -> inner Runner.Worker -> hook. A marker written after the hook returns stands in for
  // the workflow's next step.
  function runHook(event: string, payload: unknown, options: { brokenPs?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "runner-pool-hook-"));
    dirs.push(dir);
    writeFileSync(join(dir, "event.json"), JSON.stringify(payload));
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
    for (const name of ["Runner.Worker", "Runner.Listener", "host-shell"]) {
      copyFileSync(bash, join(dir, name));
      chmodSync(join(dir, name), 0o755);
    }
    let path = process.env.PATH ?? "";
    if (options.brokenPs) {
      spawnSync("mkdir", [join(dir, "bin")]);
      writeFileSync(join(dir, "bin", "ps"), "#!/usr/bin/env bash\nexit 1\n");
      chmodSync(join(dir, "bin", "ps"), 0o755);
      path = `${join(dir, "bin")}:${path}`;
    }
    const hook = resolve(import.meta.dirname, "../../scripts/ci/runner-pool/job-started.sh");
    const inner = `"${dir}/Runner.Worker" -c 'bash "${hook}"; echo $? > "${dir}/next-step"; :'`;
    const host = `"${dir}/host-shell" -c '${inner.replaceAll("'", `'\\''`)}; echo $? > "${dir}/inner-status"; :'`;
    const result = spawnSync(join(dir, "Runner.Listener"), ["-c", `${host}; echo survived > "${dir}/outer"; :`], {
      encoding: "utf8",
      env: { PATH: path, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_REPOSITORY: "HamedMP/matrix-os" },
    });
    const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim() : undefined);
    return { result, outer: read("outer"), innerStatus: read("inner-status"), nextStep: read("next-step") };
  }

  it.each([
    ["a main push", "push", {}, 0],
    ["a merge-queue run", "merge_group", {}, 0],
    ["a same-repository PR", "pull_request", { pull_request: { head: { repo: { full_name: "HamedMP/matrix-os" } } } }, 0],
    ["a fork PR", "pull_request", { pull_request: { head: { repo: { full_name: "someone/matrix-os" } } } }, 1],
    ["a PR whose head repository was deleted", "pull_request", { pull_request: { head: { repo: null } } }, 1],
    ["a manual dispatch", "workflow_dispatch", {}, 1],
    ["a privileged fork event", "pull_request_target", { pull_request: { head: { repo: { full_name: "HamedMP/matrix-os" } } } }, 1],
  ])("job-started hook decides %s", (_, event, payload, status) => {
    const { result, outer, innerStatus, nextStep } = runHook(event, payload);
    // The hosting runner always survives.
    expect(result.status, result.stderr).toBe(0);
    expect(outer).toBe("survived");
    if (status === 0) {
      expect(nextStep).toBe("0");
    } else {
      // Rejection kills the inner runner (128 + SIGKILL), so an `if: always()` step never runs.
      expect(innerStatus).toBe("137");
      expect(nextStep).toBeUndefined();
    }
  });

  it("still kills the rejected job's runner when the process table cannot be read", () => {
    const fork = { pull_request: { head: { repo: { full_name: "someone/matrix-os" } } } };
    const { result, outer, innerStatus, nextStep } = runHook("pull_request", fork, { brokenPs: true });
    expect(result.status, result.stderr).toBe(0);
    expect(outer).toBe("survived");
    expect(innerStatus).toBe("137");
    expect(nextStep).toBeUndefined();
  });

  it("installs the job-started hook where a job cannot change it", () => {
    expect(dockerfile).toContain("COPY --chown=root:root job-started.sh /opt/matrix-ci/job-started.sh");
    expect(dockerfile).toContain("RUN chmod 0555 /opt/matrix-ci/job-started.sh");
    // The CI host builds with Docker's legacy builder, which rejects BuildKit-only flags.
    expect(dockerfile).not.toMatch(/--chmod=|--mount=|^# syntax=/m);
    expect(dockerfile).toContain("ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/matrix-ci/job-started.sh");
  });

  it("reports API and Docker failures so the slot backs off", () => {
    expect(sandbox().run("run_one_job 1", { FAKE_CURL_FAIL: "1" }).status).not.toBe(0);
    expect(sandbox().run("run_one_job 1", { FAKE_DOCKER_STATUS: "125" }).status).toBe(125);
  });

  it("publishes the heartbeat variable CI routes on", () => {
    const { run, calls } = sandbox();
    expect(run("publish_heartbeat").status).toBe(0);
    // Only this host's online, idle runners count: the fixture also has a busy slot and another host's runner.
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
    // Stopped with Docker through Requires=, so each unit needs a start link from Docker to come back.
    for (const unit of ["matrix-ci-pool-slot@.service", "matrix-ci-pool-firewall.service"]) {
      expect(readFileSync(join(dir, unit), "utf8")).toMatch(/^WantedBy=multi-user\.target docker\.service$/m);
    }
    const install = readFileSync(join(dir, "install.sh"), "utf8");
    expect(install).toContain("com.docker.network.bridge.name=matrix-ci-pool0");
    expect(install).toContain("com.docker.network.bridge.enable_icc=false matrix-ci-pool");
  });

  it("ships no app identity, so the pool cannot silently reuse the CI gate app", () => {
    const example = readFileSync(resolve(import.meta.dirname, "../../scripts/ci/runner-pool/pool.env.example"), "utf8");
    expect(example).toMatch(/^APP_ID=$/m);
    expect(example).toMatch(/^INSTALLATION_ID=$/m);
  });

  it("ships a checksum-pinned Node the repository supports, so pnpm/action-setup can bootstrap", () => {
    // pnpm's installer fails on Ubuntu's Node 18; the image must not fall back to the distro package.
    const major = Number(/^ARG NODE_VERSION=(\d+)\./m.exec(dockerfile)?.[1]);
    const engine = Number(/>=(\d+)/.exec(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")).engines.node)?.[1]);
    expect(major).toBeGreaterThanOrEqual(engine);
    expect(dockerfile).toMatch(/^ARG NODE_SHA256=[a-f0-9]{64}$/m);
    expect(dockerfile).toContain('echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -');
    expect(dockerfile).not.toMatch(/^\s+nodejs npm \\$/m);
  });

  it("pins the runner base image by digest", () => {
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/actions\/actions-runner:[0-9.]+@sha256:[a-f0-9]{64}$/m);
  });
});
