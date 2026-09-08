import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SCOPE_RUNTIME_PROFILE_DIGEST } from "../../packages/scope-runtime/src/profile.js";

const acceptancePath = "scripts/spikes/collaboration/production-supervisor-acceptance.mjs";

describe("collaboration production scope-runtime acceptance", () => {
  it("refuses to change a host without the disposable acceptance marker", async () => {
    const source = await readFile(acceptancePath, "utf8");

    const guard = 'process.env.MATRIX_SCOPE_PRODUCTION_DISPOSABLE !== "1"';
    expect(source).toContain(guard);
    expect(source).toContain("scope_runtime_production_requires_disposable_host");
    expect(source.indexOf(guard)).toBeLessThan(source.lastIndexOf("runAcceptance()"));
  });

  it("requires the exact installed production bundle and restores the disabled service state", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("MATRIX_SCOPE_PRODUCTION_DISPOSABLE");
    expect(source).toContain("MATRIX_SCOPE_EXPECTED_HEAD");
    expect(source).toContain("/opt/matrix/app/BUNDLE_VERSION");
    expect(source).toContain("/opt/matrix/app/SCOPE_RUNTIME_DISABLED");
    expect(source).toContain("matrix-scope-runtime.service");
    expect(source).toContain("scope_runtime_service_default=disabled");
    expect(source).toContain("scope_runtime_disabled_marker=restored");
    expect(source).toContain("finally");
  });

  it("exercises strict frames, a bounded timeout, and fixed-profile workload creation", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("capability.get");
    expect(source).toContain("runtime.create");
    expect(source).toContain("runtime.stop");
    expect(source).toContain("malformed_frame=closed");
    expect(source).toContain("multi_frame=closed");
    expect(source).toContain("oversized_frame=closed");
    expect(source).toContain("request_timeout=closed");
    expect(source).toContain("scope_runtime_worker_ready");
    expect(source).toContain("MemoryMax=1073741824");
    expect(source).toContain("TasksMax=256");
    expect(source).toContain("PrivateNetwork=yes");
    expect(source).toContain("SUPERVISOR_OPERATION_TIMEOUT_MS = 30_000");
    expect(source).toContain('input.type === "capability.get"');
    expect(source).not.toContain("eval(");
    expect(source).not.toContain("execSync(");
    expect(source).not.toMatch(/import\s+\{\s*exec\s*\}/);
  });

  it("reports only bounded systemd launch diagnostics when runtime creation fails", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain('"matrix-scope-runtime-*.service"');
    expect(source).toContain('"--since"');
    expect(source).toContain("SYSTEMD_EXEC_STEPS");
    expect(source).toContain("runtime_create_failed_step_");
    expect(source).toContain("runtime_create_failed_status_");
    expect(source).not.toContain("runtime_create_failed:${journal.stdout}");
  });

  it("crashes and restarts the supervisor while preserving truthful runtime reconciliation", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("SIGKILL");
    expect(source).toContain("execution_generation_before=");
    expect(source).toContain("execution_generation_after=");
    expect(source).toContain("restart_reconciliation=passed");
    expect(source).toContain("shutdown_drain=passed");
    expect(source).toContain("systemctl");
  });

  it("pins evidence to the source-controlled production profile digest", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain(SCOPE_RUNTIME_PROFILE_DIGEST);
    expect(source).toContain("scope_runtime_production_acceptance=passed");
    expect(source).toContain("supervisor_version=1.0.0");
    expect(source).toContain("profile_digest=");
  });
});
