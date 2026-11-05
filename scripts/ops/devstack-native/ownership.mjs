import { lstat } from "node:fs/promises";
import { assert, command, hash } from "./control.mjs";
import { safeCode } from "./receipt.mjs";
export const IDENTITY_KEYS = ["LoadState", "Description", "Transient", "InvocationID", "MainPID", "ActiveState", "DynamicUser", "RootDirectory", "FragmentPath"];
export async function observeUnit(name, run = command) {
  const result = await run("/usr/bin/systemctl", ["show", name, ...IDENTITY_KEYS.map(key => `--property=${key}`)]);
  assert(result.code === 0, "unit_identity_unavailable"); const values = {};
  for (const line of result.stdout.split("\n")) { const i = line.indexOf("="); const key = line.slice(0, i);
    assert(IDENTITY_KEYS.includes(key) && line.length <= 4096, "unit_identity_invalid"); values[key] = line.slice(i + 1); }
  if (values.LoadState !== "not-found") {
    assert(values.FragmentPath === `/run/systemd/transient/${name}`, "unit_definition_identity_unproven");
    const entry = await lstat(values.FragmentPath, { bigint: true });
    assert(entry.isFile() && !entry.isSymbolicLink() && entry.uid === 0n && (entry.mode & 0o022n) === 0n && entry.size <= 65536n, "unit_definition_identity_unproven");
    values.DefinitionIdentity = `${await hash(values.FragmentPath)}:${entry.dev}:${entry.ino}:${entry.ctimeNs}`;
  }
  return values;
}
export function createUnitLedger(config, token, io = {}) {
  const observe = io.observe ?? (name => observeUnit(name));
  const mutate = io.mutate ?? (async (action, name) => {
    const args = action === "kill" ? ["kill", "--kill-whom=main", "--signal=SIGKILL", name] : ["stop", name];
    const result = await command("/usr/bin/systemctl", args, 55_000); assert(result.code === 0, "owned_unit_mutation_failed");
  });
  let submitted = false, supervisor, awaitingRestart = false;
  const workers = new Map(); const quarantine = []; const partialCreates = [];
  const incarnation = value => value?.LoadState === "loaded" && /^[a-f0-9]{32}$/.test(value?.InvocationID) && /^[1-9][0-9]*$/.test(value?.MainPID);
  const same = (a, b) => a.InvocationID === b.InvocationID && a.MainPID === b.MainPID;
  const stableDefinition = (a, b) => typeof a.DefinitionIdentity === "string" && a.DefinitionIdentity.length > 0 && a.DefinitionIdentity === b.DefinitionIdentity;
  const checkSupervisor = value => assert(value?.Description === token && value.Transient === "yes" && incarnation(value), "supervisor_incarnation_unproven");
  const supervisorIdentity = async () => { assert(supervisor, "supervisor_incarnation_unproven"); const current = await observe(config.supervisorUnit);
    checkSupervisor(current); assert(same(current, supervisor), "supervisor_incarnation_changed"); return current; };
  const workerName = handle => { assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid"); return `${config.workerUnitPrefix}${handle.slice(8)}.service`; };
  const checkWorker = (_handle, value) => assert(incarnation(value), "worker_incarnation_unproven");
  const workerIdentity = async handle => { const known = workers.get(handle); assert(known, "worker_not_recorded"); const current = await observe(known.name);
    checkWorker(handle, current); assert(same(current, known.identity), "worker_incarnation_changed"); return current; };
  const freshSupervisor = async () => { const current = await supervisorIdentity(); assert(stableDefinition(current, supervisor), "supervisor_definition_changed"); return current; };
  const freshWorker = async handle => { const current = await workerIdentity(handle); assert(stableDefinition(current, workers.get(handle).identity), "worker_definition_changed"); return current; };
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
    async supervisorAction(action) {
      assert(["kill", "stop"].includes(action), "supervisor_action_invalid"); await freshSupervisor();
      await mutate(action, config.supervisorUnit); if (action === "kill") awaitingRestart = true;
    },
    async recordWorker(reply) {
      const handle = reply?.runtimeHandle; const name = workerName(handle);
      assert(workers.size < 32 && !workers.has(handle) && /^[1-9][0-9]{0,19}$/.test(reply.executionGeneration), "worker_record_invalid");
      const current = await observe(name); checkWorker(handle, current);
      workers.set(handle, { name, identity: { ...current }, generation: reply.executionGeneration }); return name;
    },
    freshWorker,
    async protocolAction(handle, action) { await freshSupervisor(); await freshWorker(handle); return action(); },
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
          await verify(); await mutate("stop", name); results.push({ unit: name, state: "passed", outcome: "stopped" });
        } catch (error) { results.push({ unit: name, state: "failed", code: safeCode(error) }); }
      };
      if (submitted && !supervisor) {
        try { const current = await observe(config.supervisorUnit); if (current.LoadState !== "not-found") { checkSupervisor(current); supervisor = { ...current }; } }
        catch (error) { results.push({ unit: config.supervisorUnit, state: "failed", code: safeCode(error) }); }
      }
      if (supervisor) await attempt(config.supervisorUnit, supervisorIdentity);
      for (const [handle, entry] of workers) await attempt(entry.name, () => workerIdentity(handle));
      return results;
    },
  };
}
