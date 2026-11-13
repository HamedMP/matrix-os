import { lstat } from "node:fs/promises";
import { assert, command, hash, waitFor } from "./control.mjs";
import { safeCode } from "./receipt.mjs";
export const CASCADE_KEYS = ["BoundBy", "ConsistsOf", "RequiredBy", "RequisiteOf", "PropagatesStopTo", "PartOf", "BindsTo", "OnFailure", "OnSuccess", "ExecStop", "ExecStopPost"];
export const IDENTITY_KEYS = ["Id", "LoadState", "Description", "Transient", "InvocationID", "MainPID", "ActiveState", "DynamicUser", "RootDirectory", "FragmentPath", "KillSignal", "RuntimeDirectoryPreserve", "RemainAfterExit", "SubState", "Result", "ExecMainPID", "ExecMainCode", "ExecMainStatus", "StandardError", "LimitFSIZE", "LimitFSIZESoft", ...CASCADE_KEYS];
async function definitionIdentity(path) {
  const entry = await lstat(path, { bigint: true });
  assert(entry.isFile() && !entry.isSymbolicLink() && entry.uid === 0n && (entry.mode & 0o022n) === 0n && entry.size <= 65536n, "unit_definition_identity_unproven");
  return `${await hash(path)}:${entry.dev}:${entry.ino}:${entry.ctimeNs}`;
}
async function snapshot(name, run, readDefinition) {
  const result = await run("/usr/bin/systemctl", ["show", name, ...IDENTITY_KEYS.map(key => `--property=${key}`)]);
  assert(result.code === 0 && !result.stderrPresent, "unit_identity_unavailable"); const values = {};
  for (const line of result.stdout.split("\n")) { const i = line.indexOf("="); const key = line.slice(0, i);
    assert(i > 0 && IDENTITY_KEYS.includes(key) && !Object.hasOwn(values, key) && line.length <= 4096, "unit_identity_invalid"); values[key] = line.slice(i + 1); }
  assert(values.Id === name, "unit_name_mismatch");
  if (values.LoadState !== "not-found") {
    assert(values.FragmentPath === `/run/systemd/transient/${name}`, "unit_definition_identity_unproven");
    values.DefinitionIdentity = await readDefinition(values.FragmentPath);
  }
  return values;
}
const stopHooks = ["ExecStop", "ExecStopPost"];
export async function observeUnit(name, run = command, readDefinition = definitionIdentity) {
  assert(typeof name === "string" && name.length <= 255 && /^[a-z][a-z0-9-]*\.service$/.test(name), "unit_name_invalid");
  const before = await snapshot(name, run, readDefinition);
  if (before.LoadState === "not-found") return before;
  const missing = stopHooks.filter(key => !Object.hasOwn(before, key));
  if (!missing.length) return before;
  // systemd's object path encodes punctuation as '_' and its hex byte. The
  // unit allowlist above permits exactly two such characters (dash and dot).
  const object = "/org/freedesktop/systemd1/unit/" + name.replaceAll("-", "_2d").replace(".", "_2e");
  for (const key of missing) {
    const reply = await run("/usr/bin/busctl", ["--system", "get-property", "org.freedesktop.systemd1", object,
      "org.freedesktop.systemd1.Service", key], 3000);
    assert(reply.code === 0 && !reply.stderrPresent, "unit_hook_unavailable");
    assert(reply.stdout === "a(sasbttttuii) 0", "unit_dependency_or_stop_hook_quarantined");
  }
  // Only attach the typed proof to the definition, invocation, PID and
  // dependency snapshot it was requested for. Never cache it across actions.
  const after = await snapshot(name, run, readDefinition);
  assert(IDENTITY_KEYS.every(key => before[key] === after[key])
    && before.DefinitionIdentity === after.DefinitionIdentity, "unit_changed_during_hook_observation");
  for (const key of missing) after[key] = "";
  return after;
}
export function createUnitLedger(config, token, io = {}) {
  const check = io.check ?? (() => {});
  const observe = io.observe ?? (name => observeUnit(name));
  const mutate = io.mutate ?? (async (action, name) => {
    const args = action === "kill" ? ["kill", "--kill-whom=main", "--signal=SIGKILL", name]
      : action === "stop" && name === config.supervisorUnit ? ["kill", "--kill-whom=main", "--signal=SIGTERM", name] : ["stop", name];
    const result = await command("/usr/bin/systemctl", args, 55_000); assert(result.code === 0, "owned_unit_mutation_failed");
  });
  let submitted = false, supervisor, awaitingRestart = false, graceful;
  const workers = new Map(); const quarantine = []; const partialCreates = [];
  const incarnation = value => value?.LoadState === "loaded" && /^[a-f0-9]{32}$/.test(value?.InvocationID) && /^[1-9][0-9]*$/.test(value?.MainPID);
  const same = (a, b) => a.InvocationID === b.InvocationID && a.MainPID === b.MainPID;
  const stableDefinition = (a, b) => typeof a.DefinitionIdentity === "string" && a.DefinitionIdentity.length > 0 && a.DefinitionIdentity === b.DefinitionIdentity;
  const checkSupervisor = value => assert(value?.Description === token && value.Transient === "yes" && incarnation(value), "supervisor_incarnation_unproven");
  const supervisorIdentity = async () => { assert(supervisor, "supervisor_incarnation_unproven"); const current = await observe(config.supervisorUnit);
    checkSupervisor(current); assert(same(current, supervisor), "supervisor_incarnation_changed"); return current; };
  const exitedSupervisor = current => {
    assert(current.LoadState === "loaded" && current.Description === token && current.Transient === "yes"
      && current.InvocationID === supervisor.InvocationID && current.MainPID === "0" && current.ExecMainPID === supervisor.MainPID
      && stableDefinition(current, supervisor), "supervisor_exit_incarnation_unproven");
    assert(current.ActiveState === "active" && current.SubState === "exited" && current.RemainAfterExit === "yes"
      && current.Result === "success" && current.ExecMainCode === "1" && current.ExecMainStatus === "0", "supervisor_graceful_exit_failed");
    return current;
  };
  const supervisorCleanupIdentity = async () => {
    const current = await observe(config.supervisorUnit);
    return current.MainPID === "0" ? exitedSupervisor(current) : supervisorIdentity();
  };
  const workerName = handle => { assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid"); return `${config.workerUnitPrefix}${handle.slice(8)}.service`; };
  const checkWorker = (_handle, value) => assert(incarnation(value), "worker_incarnation_unproven");
  const workerIdentity = async handle => { const known = workers.get(handle); assert(known, "worker_not_recorded"); const current = await observe(known.name);
    checkWorker(handle, current); assert(same(current, known.identity), "worker_incarnation_changed"); return current; };
  const freshSupervisor = async () => { const current = await supervisorIdentity(); assert(stableDefinition(current, supervisor), "supervisor_definition_changed"); return current; };
  const freshWorker = async handle => { const current = await workerIdentity(handle); assert(stableDefinition(current, workers.get(handle).identity), "worker_definition_changed"); return current; };
  const cascadeSafe = current => assert(CASCADE_KEYS.every(key => current[key] === ""), "unit_dependency_or_stop_hook_quarantined");
  const transitionSafe = async () => {
    assert(quarantine.length === 0 && partialCreates.length === 0, "supervisor_drain_unproved_workers");
    for (const [handle, entry] of workers) if (!entry.released) { const current = await freshWorker(handle); cascadeSafe(current); }
  };
  const adoptExpectedRestart = async () => {
    if (!awaitingRestart || !supervisor) return false;
    const current = await observe(config.supervisorUnit);
    if (current.LoadState === "not-found" || current.MainPID === "0") return false;
    checkSupervisor(current); if (same(current, supervisor)) return false;
    assert(current.InvocationID !== supervisor.InvocationID && stableDefinition(current, supervisor), "supervisor_restart_incarnation_unproven");
    supervisor = { ...current }; awaitingRestart = false;
    return { invocationId: current.InvocationID, pid: Number(current.MainPID) };
  };
  return {
    submitted() { submitted = true; },
    async captureSupervisor({ restart = false } = {}) {
      assert(submitted && (!supervisor || restart && awaitingRestart), "supervisor_claim_not_authorized");
      const current = await observe(config.supervisorUnit); checkSupervisor(current);
      if (restart) assert(current.InvocationID !== supervisor.InvocationID && stableDefinition(current, supervisor), "supervisor_restart_incarnation_unproven");
      supervisor = { ...current }; awaitingRestart = false;
      return { invocationId: current.InvocationID, pid: Number(current.MainPID) };
    },
    freshSupervisor,
    captureExpectedRestart: adoptExpectedRestart,
    releaseWorker(handle, reply) {
      const entry = workers.get(handle); assert(entry, "worker_not_recorded");
      assert(reply?.state === "stopped" && reply.runtimeHandle === handle, "runtime_stop_failed");
      assert(reply.executionGeneration === entry.generation, "runtime_stop_generation_mismatch");
      entry.released = true;
    },
    async supervisorAction(action, beginClose) {
      assert(["kill", "stop"].includes(action), "supervisor_action_invalid");
      const current = await freshSupervisor(); cascadeSafe(current); await transitionSafe();
      const transition = { supervisor: { ...current }, handles: [...workers].filter(([, item]) => !item.released).map(([handle]) => handle) };
      if (action === "stop") {
        assert(typeof beginClose === "function", "close_evidence_required");
        transition.verifyClose = await beginClose(transition.supervisor, transition.handles);
        assert(typeof transition.verifyClose === "function", "close_evidence_required");
        cascadeSafe(await freshSupervisor()); await transitionSafe();
      }
      check();
      await mutate(action, config.supervisorUnit); if (action === "kill") awaitingRestart = true;
      else graceful = transition;
    },
    async waitForGracefulDrain(handle, socketAbsent, timeout = 55_000) {
      assert(graceful && graceful.handles.includes(handle), "graceful_transition_not_recorded");
      return waitFor(async () => {
        const current = await observe(config.supervisorUnit);
        if (current.LoadState === "not-found") return false; // Default fields after GC are not exit evidence.
        assert(current.InvocationID === graceful.supervisor.InvocationID && stableDefinition(current, graceful.supervisor), "supervisor_incarnation_changed");
        if (current.MainPID !== "0") {
          assert(current.MainPID === graceful.supervisor.MainPID && current.ActiveState !== "failed", "supervisor_exit_incarnation_unproven"); return false;
        }
        const exited = exitedSupervisor(current), drained = [];
        for (const tracked of graceful.handles) {
          const known = workers.get(tracked), worker = await observe(known.name);
          if (worker.LoadState === "not-found") { drained.push({ unit: known.name, outcome: "collected_after_controller_close" }); continue; }
          assert(worker.InvocationID === known.identity.InvocationID && stableDefinition(worker, known.identity), "worker_incarnation_changed");
          assert(worker.ActiveState !== "failed", "worker_drain_failed");
          if (worker.MainPID !== "0" || worker.ActiveState !== "inactive") return false;
          assert(worker.ExecMainPID === known.identity.MainPID && worker.Result === "success", "worker_exit_incarnation_unproven");
          drained.push({ unit: known.name, outcome: "inactive", invocationId: worker.InvocationID });
        }
        if (!await socketAbsent()) return false;
        const controllerClose = await graceful.verifyClose();
        return { controllerClose, ownSupervisorStopped: true, workerInactive: true, supervisorSocketAbsent: true,
          supervisor: { invocationId: exited.InvocationID, originalPid: Number(exited.ExecMainPID), processExited: true, unitRetained: true,
            activeState: exited.ActiveState, subState: exited.SubState, result: exited.Result, exitCode: exited.ExecMainCode, exitStatus: Number(exited.ExecMainStatus) }, workers: drained };
      }, "graceful_termination_unproven", timeout);
    },
    async recordWorker(reply) {
      const handle = reply?.runtimeHandle; const name = workerName(handle);
      assert(workers.size < 32 && !workers.has(handle) && /^[1-9][0-9]{0,19}$/.test(reply.executionGeneration), "worker_record_invalid");
      const current = await observe(name); checkWorker(handle, current);
      workers.set(handle, { name, identity: { ...current }, generation: reply.executionGeneration }); return name;
    },
    freshWorker,
    async protocolAction(handle, action) { await freshSupervisor(); const current = await freshWorker(handle); cascadeSafe(current); check(); return action(); },
    inventory(names) {
      assert(names.length <= 64, "quarantine_capacity");
      for (const name of names) if (typeof name === "string" && name.startsWith(config.workerUnitPrefix)
        && /^[a-z0-9-]+\.service$/.test(name) && ![...workers.values()].some(item => item.name === name)) {
        if (!quarantine.includes(name)) quarantine.push(name);
      }
      assert(quarantine.length <= 64, "quarantine_capacity"); return [...quarantine];
    },
    partialCreate(scopeHandle, error) { assert(/^scope_[a-f0-9]{32}$/.test(scopeHandle) && partialCreates.length < 32, "partial_create_capacity"); partialCreates.push({ scopeHandle, code: safeCode(error), state: "quarantined_unknown" }); },
    evidence() { return { supervisor: supervisor ? { unit: config.supervisorUnit, invocationId: supervisor.InvocationID, pid: Number(supervisor.MainPID), definitionIdentity: supervisor.DefinitionIdentity } : null,
      workers: [...workers.entries()].map(([handle, value]) => ({ handle, unit: value.name, invocationId: value.identity.InvocationID, pid: Number(value.identity.MainPID), definitionIdentity: value.identity.DefinitionIdentity })) }; },
    quarantine() { return [...quarantine, ...partialCreates]; },
    async cleanup() {
      const results = [];
      const attempt = async (name, verify) => {
        try {
          const current = await observe(name);
          if (current.LoadState === "not-found") { results.push({ unit: name, state: "passed", outcome: "already_absent" }); return; }
          if (current.ActiveState === "inactive" && current.MainPID === "0") {
            const expected = name === config.supervisorUnit ? supervisor : [...workers.values()].find(item => item.name === name)?.identity;
            assert(expected && current.InvocationID === expected.InvocationID, "inactive_incarnation_changed");
            results.push({ unit: name, state: "passed", outcome: "already_inactive" }); return;
          }
          const proven = await verify(); cascadeSafe(proven);
          if (name === config.supervisorUnit) {
            assert(["9", "SIGKILL"].includes(proven.KillSignal), "supervisor_cold_stop_signal_unproven");
            assert(proven.RuntimeDirectoryPreserve === "yes", "supervisor_cold_stop_preservation_unproven");
          }
          await mutate(name === config.supervisorUnit ? "stop-cold" : "stop", name); results.push({ unit: name, state: "passed", outcome: "stopped" });
        } catch (error) { results.push({ unit: name, state: "failed", code: safeCode(error) }); }
      };
      if (submitted && !supervisor) {
        try { const current = await observe(config.supervisorUnit); if (current.LoadState !== "not-found") { checkSupervisor(current); supervisor = { ...current }; } }
        catch (error) { results.push({ unit: config.supervisorUnit, state: "failed", code: safeCode(error) }); }
      }
      if (awaitingRestart && supervisor) try { await adoptExpectedRestart(); } catch (error) { results.push({ unit: config.supervisorUnit, state: "failed", code: safeCode(error) }); }
      if (supervisor) await attempt(config.supervisorUnit, supervisorCleanupIdentity);
      for (const [handle, entry] of workers) await attempt(entry.name, () => workerIdentity(handle));
      return results;
    },
  };
}
