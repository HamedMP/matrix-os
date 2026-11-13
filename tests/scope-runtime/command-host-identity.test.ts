import { expect, it, vi } from "vitest";
import { lookupCommandIpcGroup, resolveCommandSocketTrust } from "../../packages/scope-runtime/src/command-host-identity.js";
const binding = () => ({ unit: "matrix-devstack-test-scope-runtime-" + "a".repeat(32) + ".service", root: "/owned/runtimes/a/root",
  parent: { uid: 0, gid: 987 }, validateProvenance: vi.fn(async () => {}) });
const snapshot = (b = binding()) => ({ Id: b.unit, ActiveState: "active", MainPID: "1234", InvocationID: "a".repeat(32),
  User: "matrix-scope-workload", DynamicUser: "yes", PrivateUsers: "yes", RootDirectory: b.root });
it("brackets fixed-name NSS lookup with the same PID1 invocation and fresh provenance", async () => {
  const b = binding(), unit = Object.entries(snapshot(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const execute = vi.fn(async (_command: string, args: readonly string[]) => ({ stdout: args[0] === "passwd"
    ? "matrix-scope-workload:x:61234:61234::/:/usr/sbin/nologin\n" : unit }));
  await expect(resolveCommandSocketTrust(b, execute)).resolves.toEqual({ uid: 0, gid: 987, workloadUid: 61234 });
  expect(execute.mock.calls.map(c => [c[0], c[1][0]])).toEqual([["/usr/bin/systemctl", "show"], ["/usr/bin/getent", "passwd"], ["/usr/bin/systemctl", "show"]]);
  expect(execute.mock.calls[1]![1]).toEqual(["passwd", "matrix-scope-workload"]);
  expect(b.validateProvenance).toHaveBeenCalledTimes(2);
});
it.each(["Id", "ActiveState", "MainPID", "InvocationID", "User", "DynamicUser", "PrivateUsers", "RootDirectory"])("rejects mismatched unit %s before lookup", async property => {
  const b = binding(), fields = { ...snapshot(b), [property]: "foreign" };
  const execute = vi.fn(async () => ({ stdout: Object.entries(fields).map(([k,v]) => `${k}=${v}`).join("\n") }));
  await expect(resolveCommandSocketTrust(b, execute)).rejects.toThrow("Unsafe"); expect(execute).toHaveBeenCalledOnce();
});
it.each(["MainPID", "InvocationID"])("rejects an invocation changing %s across NSS", async property => {
  const b = binding(); let count = 0;
  const execute = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args[0] === "passwd") return { stdout: "matrix-scope-workload:x:61234:61234::/:/bin/false\n" };
    const fields = snapshot(b); if (count++ > 0) fields[property as "MainPID"] = property === "MainPID" ? "1235" : "b".repeat(32);
    return { stdout: Object.entries(fields).map(([k,v]) => `${k}=${v}`).join("\n") };
  });
  await expect(resolveCommandSocketTrust(b, execute)).rejects.toThrow("Changed");
});
it.each(["foreign:x:61234:61234::/:/bin/false\n", "matrix-scope-workload:x:0:0::/:/bin/false\n", "matrix-scope-workload:x:61234:61234::/:/bin/false\nextra"])("refuses invalid fixed-name NSS output %s", async passwd => {
  const b = binding(); const execute = vi.fn(async (_c: string, a: readonly string[]) => ({ stdout: a[0] === "passwd" ? passwd : Object.entries(snapshot(b)).map(([k,v]) => `${k}=${v}`).join("\n") }));
  await expect(resolveCommandSocketTrust(b, execute)).rejects.toThrow("Unsafe");
});
it("resolves only the fixed matrix group and fails closed on ambiguous or failed lookup", async () => {
  const execute = vi.fn(async () => ({ stdout: "matrix:x:987:\n" }));
  await expect(lookupCommandIpcGroup(execute)).resolves.toBe(987);
  expect(execute).toHaveBeenCalledWith("/usr/bin/getent", ["group", "matrix"]);
  for (const stdout of ["other:x:987:\n", "matrix:x:4294967295:\n", "matrix:x:987:\nextra"]) {
    await expect(lookupCommandIpcGroup(async () => ({ stdout }))).rejects.toThrow("Unsafe");
  }
  await expect(lookupCommandIpcGroup(async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
});
