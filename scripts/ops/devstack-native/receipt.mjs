import { assert, safeCode } from "./control.mjs";
export { safeCode } from "./control.mjs";
const RESOURCE_ROLES = ["isolation_control", "peer_control", "sdk", "drain"];
const GATES = ["placement", "baseline", "dependencies", "build", "supervisor", "capability", "supervisor_security", "isolation", "sdk_isolation", "sdk", "broker_mock", "first_broker_cleanup", "crash", "restart", "reconcile", "command_cleanup", "drain", "broker_cleanup", "controls_cleanup", "cleanup", "unchanged"];
export function createJournal() {
  const gates = Object.fromEntries(GATES.map(name => [name, { state: "not_run" }]));
  let failed = false; const resources = {};
  return {
    async step(name, action) {
      assert(Object.hasOwn(gates, name) && gates[name].state === "not_run", "receipt_gate_invalid");
      gates[name] = { state: "running" };
      try { const evidence = await action(); gates[name] = { state: "passed", evidence }; return evidence; }
      catch (error) { failed = true; gates[name] = { state: "failed", code: safeCode(error) }; throw error; }
    },
    async resourceStep(handle, role, action) {
      assert(/^runtime_[a-f0-9]{32}$/.test(handle) && RESOURCE_ROLES.includes(role)
        && !Object.hasOwn(resources, handle) && Object.keys(resources).length < 32, "receipt_resource_invalid");
      resources[handle] = { role, state: "running" };
      try { const evidence = await action(); resources[handle] = { role, state: "passed", evidence }; return evidence; }
      catch (error) { failed = true; resources[handle] = { role, state: "failed", code: safeCode(error) }; throw error; }
    },
    fail(error) { failed = true; return safeCode(error); },
    result() { const values = Object.values(resources); return { status: failed || GATES.some(name => gates[name].state !== "passed") || values.length !== RESOURCE_ROLES.length || values.some(value => value.state !== "passed") || new Set(values.map(value => value.role)).size !== RESOURCE_ROLES.length ? "failed" : "passed", gates, resources }; },
  };
}
export function safeCapability(reply) {
  const profile = reply?.profile;
  assert(profile && profile.profileId === "scope-runtime-chat-v1" && profile.profileVersion === 3
    && /^[a-f0-9]{64}$/.test(profile.profileDigest) && /^[1-9][0-9]{0,19}$/.test(profile.executionGeneration)
    && Array.isArray(profile.adapters) && profile.adapters.length === 1, "capability_invalid");
  const adapter = profile.adapters.find(item => item?.adapterId === "claude-code");
  assert(adapter && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(adapter.harnessVersion), "capability_adapter_invalid");
  return { profileId: profile.profileId, profileVersion: profile.profileVersion, profileDigest: profile.profileDigest,
    executionGeneration: profile.executionGeneration, adapter: { adapterId: "claude-code", harnessVersion: adapter.harnessVersion } };
}
