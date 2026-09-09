import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SCOPE_RUNTIME_PROFILE_DIGEST } from "../../packages/scope-runtime/src/profile.js";

const acceptancePath = "scripts/spikes/collaboration/production-supervisor-acceptance.mjs";

describe("collaboration production scope-runtime acceptance", () => {
  it("reserves cleanup margin beyond the bounded preview and remote-command budgets", async () => {
    const workflow = await readFile(
      ".github/workflows/collaboration-scope-runtime-acceptance.yml",
      "utf8",
    );

    expect(workflow).toContain("timeout-minutes: 60");
    expect(workflow).toContain("deadline=$((SECONDS + 2100))");
  });

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
    expect(source).toContain("/opt/matrix/release.json");
    expect(source).toContain("release.gitCommit === expectedHead");
    expect(source).not.toContain("expectedHead.slice(0, 7)");
    expect(source).toContain("/opt/matrix/app/SCOPE_RUNTIME_DISABLED");
    expect(source).toContain("matrix-scope-runtime.service");
    expect(source).toContain("scope_runtime_service_default=disabled");
    expect(source).toContain("scope_runtime_disabled_marker=restored");
    expect(source).toContain("finally");
  });

  it("restores the disabled marker even when service cleanup fails", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("restoreDormantService");
    expect(source).toContain("service_cleanup_failed");
    expect(source).toContain('"kill", "--kill-whom=all", "--signal=SIGKILL", SERVICE');
    expect(source).toContain("await restoreDormantService(runtimeUnits)");
    expect(source.indexOf("await restoreDormantService(runtimeUnits)")).toBeLessThan(
      source.indexOf("await rename(MARKER_BACKUP, DISABLED_MARKER)"),
    );
    expect(source).toMatch(
      /try \{\s+await restoreDormantService\(runtimeUnits\);\s+\} finally \{\s+if \(markerMoved\)/,
    );
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
    expect(source).toContain('"--show-cursor"');
    expect(source).toContain('"--after-cursor", cursor');
    expect(source).toContain("journal_cursor_unavailable");
    expect(source).toContain('"--grep", "^scope_runtime_worker_failed:"');
    expect(source).toContain("SYSTEMD_EXEC_STEPS");
    expect(source).toContain("runtime_create_failed_step_");
    expect(source).toContain("runtime_create_failed_status_");
    expect(source).toContain("runtime_create_failed_activation_status_");
    expect(source).toContain("SYSTEMD_WORKER_FAILURES");
    expect(source).toContain('ScopeRuntimeReadinessError: "readiness"');
    expect(source).toContain("runtime_create_failed_worker_");
    expect(source).toContain('"--unit", SERVICE, "--after-cursor", cursor');
    expect(source).toContain("supervisorWorker");
    expect(source.indexOf("supervisorWorker")).toBeLessThan(
      source.indexOf("workerJournal"),
    );
    expect(source.indexOf("supervisorWorker")).toBeLessThan(
      source.indexOf("activationStatus"),
    );
    expect(source).not.toContain('"--since", since');
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
