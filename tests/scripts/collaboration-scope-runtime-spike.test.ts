import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const acceptancePath = "scripts/spikes/collaboration/native-isolation-acceptance.sh";

describe("collaboration scope-runtime native isolation spike", () => {
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
    expect(source).toContain("baseline unexpectedly passed");
    expect(source).toContain("run_fixed_profile_candidate");
    expect(source.indexOf("run_unrestricted_baseline")).toBeLessThan(
      source.lastIndexOf("run_fixed_profile_candidate"),
    );
  });

  it("uses one fixed non-root systemd profile with no caller-supplied command or host path", async () => {
    const source = await readFile(acceptancePath, "utf8");

    for (const property of [
      "User=62000",
      "Group=62000",
      "PrivateUsers=yes",
      "RootDirectory=",
      "PrivateNetwork=yes",
      "ProtectProc=invisible",
      "ProcSubset=pid",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "RestrictAddressFamilies=AF_UNIX",
      "MemoryMax=1073741824",
      "CPUQuota=200%",
      "TasksMax=256",
      "TemporaryFileSystem=/workspace:rw,size=10G,mode=0700,uid=62000,gid=62000",
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
});
