import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
} from "../../packages/scope-runtime/src/profile.js";

const acceptancePath = "scripts/spikes/collaboration/production-supervisor-acceptance.mjs";

describe("collaboration production scope-runtime acceptance", () => {
  it("reserves cleanup margin beyond the bounded preview and remote-command budgets", async () => {
    const workflow = await readFile(
      ".github/workflows/collaboration-scope-runtime-acceptance.yml",
      "utf8",
    );

    expect(workflow).toContain("timeout-minutes: 60");
    expect(workflow).toContain("deadline=$((SECONDS + 2100))");
    expect(workflow).toContain('contains("scope_runtime_chat=passed")');
  });

  it("refuses to change a host without the disposable acceptance marker", async () => {
    const source = await readFile(acceptancePath, "utf8");

    const guard = 'process.env.MATRIX_SCOPE_PRODUCTION_DISPOSABLE !== "1"';
    expect(source).toContain(guard);
    expect(source).toContain("scope_runtime_production_requires_disposable_host");
    expect(source.indexOf(guard)).toBeLessThan(source.lastIndexOf("runAcceptance()"));
  });

  it("requires the exact installed production bundle and restores the original supervisor state", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("MATRIX_SCOPE_PRODUCTION_DISPOSABLE");
    expect(source).toContain("MATRIX_SCOPE_EXPECTED_HEAD");
    expect(source).toContain("/opt/matrix/app/BUNDLE_VERSION");
    expect(source).toContain("/opt/matrix/release.json");
    expect(source).toContain("release.gitCommit === expectedHead");
    expect(source).not.toContain("expectedHead.slice(0, 7)");
    expect(source).toContain("matrix-scope-runtime.service");
    // Main activated the supervisor in #1602: production bundles no longer ship the
    // dormant marker, so the proof must observe and restore whatever state the exact
    // preview has instead of demanding a disabled host.
    expect(source).not.toContain("disabled_marker_required");
    expect(source).not.toContain("service_enabled_unexpectedly");
    expect(source).not.toContain("service_active_unexpectedly");
    expect(source).not.toContain("scope_runtime_service_default=disabled");
    expect(source).toContain("captureOriginalServiceState");
    expect(source).toContain("service_state_invalid");
    expect(source).toContain("scope_runtime_service_enabled_before=");
    expect(source).toContain("scope_runtime_service_active_before=");
    expect(source).toContain("scope_runtime_service_state=restored");
    expect(source).toContain("service_state_not_restored");
    expect(source).toContain("finally");
  });

  it("tolerates a legacy dormant marker without requiring, shipping, or leaving it behind", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("/opt/matrix/app/SCOPE_RUNTIME_DISABLED");
    expect(source).toContain("await rename(DISABLED_MARKER, MARKER_BACKUP)");
    expect(source).toContain("await rename(MARKER_BACKUP, DISABLED_MARKER)");
    expect(source).toContain('scope_runtime_disabled_marker=${markerMoved ? "restored" : "absent"}');
    expect(source).not.toMatch(/writeFile\([^)]*DISABLED_MARKER/);
    expect(source).not.toContain("scope_runtime_disabled_marker=restored\\n");
  });

  it("restores the original service state even when workload cleanup fails", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("restoreOriginalService");
    expect(source).not.toContain("restoreDormantService");
    expect(source).toContain("service_cleanup_failed");
    expect(source).toContain('"kill", "--kill-whom=all", "--signal=SIGKILL", SERVICE');
    expect(source).toContain("await restoreOriginalService(original, runtimeUnits)");
    expect(source.indexOf("await restoreOriginalService(original, runtimeUnits)")).toBeLessThan(
      source.indexOf("await rename(MARKER_BACKUP, DISABLED_MARKER)"),
    );
    expect(source).toMatch(
      /try \{\s+await restoreOriginalService\(original, runtimeUnits\);\s+\} finally \{\s+if \(markerMoved\)/,
    );
  });

  it("proves Codex on an activated host without globally disabling the Claude supervisor", async () => {
    const source = await readFile(acceptancePath, "utf8");

    // A supervisor that was enabled before the proof stays enabled; only a host that
    // was already dormant is returned to disabled.
    expect(source).toMatch(/if \(original\.enabled === "disabled"\)[\s\S]{0,240}\["disable", SERVICE\]/);
    expect(source).not.toMatch(/\n\s+await command\("\/usr\/bin\/systemctl", \["disable", SERVICE\]\);\n\s+\n/);
    // An originally active supervisor is stopped only to get a cold, drained start and is
    // started again afterwards; a dormant host is left stopped.
    expect(source).toMatch(/if \(original\.active\)[\s\S]{0,400}\["start", SERVICE\]/);
    expect(source).toContain("await stopServiceForProof(");
    // The gateway owns the production broker socket inside the supervisor's runtime
    // directory, which systemd removes on stop. The proof cannot restart the gateway
    // inline because the gateway is executing this command, so it schedules a bounded
    // deferred restart that fires after the response is returned.
    expect(source).toContain('"/usr/bin/systemd-run"');
    expect(source).toContain("--on-active=");
    expect(source).toContain('"try-restart", "matrix-gateway.service"');
    expect(source).toContain('scope_runtime_gateway_restart=${');
    expect(source).not.toContain('["restart", "matrix-gateway.service"]');
    expect(source).not.toContain('["stop", "matrix-gateway.service"]');
  });

  it("exercises strict frames, a bounded timeout, and fixed-profile workload creation", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain("capability.get");
    expect(source).toContain("runtime.create");
    expect(source).toContain("runtime.chat");
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

  it("runs the installed Agent SDK worker through a bounded fake inference broker", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain('["inference.messages", "inference.responses"]');
    expect(source).toContain('request.method === "HEAD"');
    expect(source).toContain('request.method !== "POST"');
    expect(source).toContain("scope-sdk-ok");
    expect(source).toContain("scope-codex-ok");
    expect(source).toContain("scope_runtime_codex_chat=passed");
    expect(source).toContain("body.tools.length !== 0");
    expect(source).toContain("scope_runtime_chat=passed");
    expect(source).toContain("MAX_BROKER_REQUEST_BYTES");
    expect(source).toContain("BROKER_SOCKET_TIMEOUT_MS");
  });

  it("reports only bounded supervisor diagnostics when the supervisor socket never appears", async () => {
    const source = await readFile(acceptancePath, "utf8");

    // A supervisor that starts but exits or crash-loops before creating its socket
    // must surface a bounded, content-free reason instead of a bare timeout.
    expect(source).toContain("supervisorStartFailureCode");
    expect(source).toContain("await awaitSupervisorSocket(startCursor)");
    expect(source).toContain('"--grep", "^scope_runtime_supervisor_failed:"');
    expect(source).toContain("scope_runtime_supervisor_failed:\\s+([A-Za-z]{1,64}Error)");
    expect(source).toContain('"--property=ActiveState"');
    expect(source).toContain('"--property=SubState"');
    expect(source).toContain('"--property=Result"');
    expect(source).toContain('"--property=NRestarts"');
    expect(source).toContain('"--property=ExecMainStatus"');
    expect(source).toContain("supervisor_socket_unavailable_");
    expect(source).toContain("condition_failed");
    expect(source).not.toContain("supervisor_socket_unavailable_${journal.stdout}");
    expect(source).not.toMatch(/supervisor_socket_unavailable_\$\{[^}]*stdout\}/);
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
    expect(source).toContain("await stopRuntime(firstHandle, generationBefore)");
    expect(source).not.toContain("await stopRuntime(firstHandle, generationAfter)");
    expect(source).toContain("systemctl");
  });

  it("pins evidence to the source-controlled production profile digest", async () => {
    const source = await readFile(acceptancePath, "utf8");

    expect(source).toContain(SCOPE_RUNTIME_PROFILE_DIGEST);
    expect(source).toContain(SCOPE_RUNTIME_PROFILE_ID);
    expect(source).toContain(SCOPE_RUNTIME_HARNESS_VERSION);
    expect(source).not.toContain('EXPECTED_PROFILE_ID = "scope-runtime-proof-v1"');
    expect(source).toContain("scope_runtime_production_acceptance=passed");
    expect(source).toContain("supervisor_version=1.0.0");
    expect(source).toContain("profile_digest=");
  });
});
