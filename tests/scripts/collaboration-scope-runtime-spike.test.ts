import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const acceptancePath = "scripts/spikes/collaboration/native-isolation-acceptance.sh";
const brokerFixturePath = "scripts/spikes/collaboration/scope-runtime-broker-fixture.mjs";
const probePath = "scripts/spikes/collaboration/scope-runtime-probe.ts";
const sdkProbePath = "scripts/spikes/collaboration/scope-runtime-sdk-probe.mjs";

describe("collaboration scope-runtime native isolation spike", () => {
  it("accepts only the executable root-owned staging path used by the workflow", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain(
      'if [ "$asset_root" != "/var/lib/matrix-scope-runtime/acceptance" ]; then',
    );
    expect(source).not.toContain(
      'if [ "$asset_root" != "/run/matrix-scope-runtime-acceptance" ]; then',
    );
    expect(source).toContain(
      'readonly baseline_root="/var/tmp/matrix-scope-baseline-${probe_root##*.}"',
    );
    expect(source).toContain(
      '/usr/bin/install --owner=root --group=root --mode=0644 -- "$probe_source" "$baseline_probe_source"',
    );
    expect(source).toContain('"$node_bin" "$baseline_probe_source"');
  });

  it("refuses to touch a host without the disposable acceptance marker", () => {
    const result = spawnSync("bash", [acceptancePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("scope_runtime_acceptance_requires_disposable_host");
  });

  it("requires a detecting baseline before the fixed-profile candidate can pass", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("run_unrestricted_baseline");
    expect(source).toContain("cd /tmp");
    expect(source).toContain("--reuid=matrix");
    expect(source).toContain("MATRIX_SCOPE_PROBE_OWNER_SECRET=baseline-leak");
    expect(source).toContain("expected_baseline_results");
    expect(source).toContain("baseline_check_mismatch");
    for (const check of [
      "filesystem:/home/matrix/home",
      "filesystem:/root",
      "filesystem:/run/postgresql",
      "filesystem:/run/containerd/containerd.sock",
      "filesystem:/var/run/docker.sock",
      "filesystem:/run/systemd/private",
      "filesystem:scope-root",
      "environment:allowlist",
      "process:namespace",
      "descriptor:inheritance",
      "network:loopback",
      "network:metadata",
      "network:private",
      "network:public",
      "network:dns",
      "broker:socket",
      "supervisor:injection",
      "child:boundary-inheritance",
    ]) expect(source).toContain(`"${check}"`);
    expect(source).toContain("baseline unexpectedly passed");
    expect(source).toContain("run_fixed_profile_candidate");
    expect(source.indexOf("run_unrestricted_baseline")).toBeLessThan(
      source.lastIndexOf("run_fixed_profile_candidate"),
    );
  });

  it("uses one fixed non-root systemd profile with no caller-supplied command or host path", async () => {
    const source = await readFile(acceptancePath, "utf8");

    for (const property of [
      "User=matrix-scope-probe",
      "DynamicUser=yes",
      "PrivateUsers=yes",
      "RootDirectory=",
      "PrivateNetwork=yes",
      "ProtectProc=invisible",
      "ProcSubset=pid",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "MemoryMax=1073741824",
      "CPUQuota=200%",
      "TasksMax=256",
      "TemporaryFileSystem=/workspace:rw,nosuid,nodev,size=10G,mode=1777",
    ]) {
      expect(source).toContain(property);
    }
    expect(source).not.toContain("eval ");
    expect(source).not.toContain("bash -c");
    expect(source).not.toContain("sh -c");
  });

  it("creates exact broker and supervisor sentinels and always removes probe artifacts", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("/run/matrix-scope/broker.sock");
    expect(source).toContain("/run/matrix-scope-runtime/supervisor.sock");
    expect(source).toContain("trap cleanup EXIT INT TERM");
    expect(source).toContain("systemctl stop");
    expect(source).toContain("rm -rf -- \"$probe_root\"");
  });

  it("runs the installed Agent SDK and native harness inside the same fixed profile", async () => {
    const [acceptance, sdkProbe] = await Promise.all([
      readFile(acceptancePath, "utf8"),
      readFile(sdkProbePath, "utf8"),
    ]);

    expect(acceptance).toContain("run_agent_sdk_candidate");
    expect(acceptance).toContain("@anthropic-ai/claude-agent-sdk/package.json");
    expect(acceptance).toContain("@anthropic-ai/claude-agent-sdk-linux-x64/package.json");
    expect(sdkProbe).toContain("/opt/matrix/scope-sdk/native/claude");
    expect(sdkProbe).toContain("pathToClaudeCodeExecutable");
    expect(sdkProbe).toContain("/run/matrix-scope/broker.sock");
    expect(sdkProbe).toContain("sdk_query:passed");
  });

  it("emits public-safe host, toolchain, profile, quota, and eligibility evidence", async () => {
    const source = await readFile(acceptancePath, "utf8");

    for (const evidence of [
      "host_os_id=",
      "host_os_version=",
      "kernel_release=",
      "architecture=",
      "systemd_version=",
      "node_version=",
      "fixed_profile_sha256=",
      "memory_max_bytes=",
      "cpu_quota_percent=",
      "tasks_max=",
      "storage_max_bytes=",
      "agent_sdk_version=",
      "native_harness_version=",
      "scope_identity=dynamic",
      "scope_runtime_eligibility=",
    ]) {
      expect(source).toContain(evidence);
    }
    expect(source).toContain("failed_candidate_report_begin");
    expect(source).toContain("failed_sdk_candidate_report_begin");
    expect(source).toContain("emit_unit_failure");
    expect(source).toContain("ExecMainStatus");
    expect(source).not.toContain("--collect");
  });

  it("keeps the proof broker action-bound and rejects arbitrary destinations", async () => {
    const [brokerFixture, sdkProbe] = await Promise.all([
      readFile(brokerFixturePath, "utf8"),
      readFile(sdkProbePath, "utf8"),
    ]);

    expect(brokerFixture).toContain('action !== "inference.messages"');
    expect(brokerFixture).toContain('path !== "/v1/messages?beta=true"');
    expect(brokerFixture).toContain("request_too_large");
    expect(sdkProbe).toContain('action: "inference.messages"');
    expect(sdkProbe).toContain('action: "host.fetch"');
    expect(sdkProbe).not.toContain("targetUrl");
    expect(sdkProbe).not.toContain("command:");
  });

  it("tests forbidden path access rather than rejecting protected mount placeholders", async () => {
    const source = await readFile(probePath, "utf8");

    expect(source).toContain("constants.O_NOFOLLOW");
    expect(source).toContain("await handle.close()");
    expect(source).not.toContain("await lstat(path)");
  });
});
