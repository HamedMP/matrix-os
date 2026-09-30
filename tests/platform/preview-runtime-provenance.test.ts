import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const REPOSITORY = "HamedMP/matrix-os";
const manual = {
  id: 123, event: "workflow_dispatch", head_branch: "main",
  head_sha: "b".repeat(40), status: "completed", conclusion: "success",
  head_repository: { full_name: REPOSITORY },
};
const release = {
  schemaVersion: 1, kind: "matrix-os-host-bundle", channel: "none",
  gitCommit: SHA, version: "v2026.09.30-pr2055-123-1-aaaaaaa",
};

function select(overrides: { run?: object; release?: object; expired?: boolean; missingBundle?: boolean; zipName?: string; zipText?: string; size?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preview-provenance-test-"));
  try {
    const archive = join(dir, "bundle.zip");
    const create = spawnSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr(sys.argv[2],sys.argv[3]); z.close()", archive, overrides.zipName ?? "release.json", overrides.zipText ?? JSON.stringify(overrides.release ?? release)], { encoding: "utf8" });
    expect(create.status, create.stderr).toBe(0);
    const fixtures = {
      runs: { workflow_runs: [overrides.run ?? manual] },
      artifacts: { artifacts: [
        { id: 1, name: "preview-runtime-access-2055", expired: overrides.expired ?? false, size_in_bytes: 300 },
        ...(overrides.missingBundle ? [] : [{ id: 2, name: "preview-bundle-2055", expired: false, size_in_bytes: overrides.size ?? 1000 }]),
      ] },
    };
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/usr/bin/env python3\nimport sys,json\nf=json.loads(${JSON.stringify(JSON.stringify(fixtures))})\np=sys.argv[2]\nif 'workflows/preview-vps.yml/runs?' in p: print(json.dumps(f['runs']))\nelif '/runs/123/artifacts?' in p: print(json.dumps(f['artifacts']))\nelif p.endswith('/artifacts/2/zip'): sys.stdout.buffer.write(open(${JSON.stringify(archive)},'rb').read())\nelse: sys.exit(99)\n`);
    chmodSync(gh, 0o700);
    return spawnSync("python3", ["scripts/select-manual-preview-runtime.py", REPOSITORY, "2055", SHA], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("manual preview runtime provenance", () => {
  it("selects a trusted main dispatch by its built commit, despite its different workflow SHA", () => {
    const result = select();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("123");
  });
  it.each([
    ["a stale bundle", { release: { ...release, gitCommit: "c".repeat(40) } }],
    ["another PR", { release: { ...release, version: "v2026.09.30-pr2000-123-1-aaaaaaa" } }],
    ["another short SHA", { release: { ...release, version: "v2026.09.30-pr2055-123-1-ccccccc" } }],
    ["another bundle kind", { release: { ...release, kind: "other" } }],
    ["an ordinary production channel", { release: { ...release, channel: "dev" } }],
    ["an expired runtime artifact", { expired: true }],
    ["a missing bundle artifact", { missingBundle: true }],
    ["a bundle over the download bound", { size: 3 * 1024 ** 3 }],
    ["a fork dispatch", { run: { ...manual, head_repository: { full_name: "outsider/fork" } } }],
    ["an untrusted branch", { run: { ...manual, head_branch: "feature" } }],
    ["an unsuccessful deployment", { run: { ...manual, conclusion: "failure" } }],
    ["a PR event pretending to be manual", { run: { ...manual, event: "pull_request" } }],
    ["a missing release", { zipName: "other.json" }],
    ["a malformed release", { zipText: "{" }],
    ["an oversized release", { zipText: " ".repeat(65_537) }],
  ] as const)("rejects %s", (_label, overrides) => {
    const result = select(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
