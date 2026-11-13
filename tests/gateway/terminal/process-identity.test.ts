import { describe, expect, it } from "vitest";
import { parseLinuxProcess, verifyTerminalDescendant, type LinuxProcessIdentity } from "../../../packages/gateway/src/terminal/process-identity.js";
const root: LinuxProcessIdentity = { pid: 40, ppid: 20, uid: 501, gid: 20, start: "1000" };
const leaf: LinuxProcessIdentity = { ...root, pid: 42, ppid: 40, start: "1100" };
const read = async (pid: number) => { if (pid === 40) return root; if (pid === 42) return leaf; throw new Error("missing"); };
describe("Terminal actual root incarnation ancestry", () => {
  it("accepts a stable descendant and rejects same-user sibling, foreign uid/gid and closed root", async () => {
    expect(await verifyTerminalDescendant(root, leaf, read)).toEqual(leaf);
    expect(await verifyTerminalDescendant(root, { ...leaf, pid: 41 }, async pid => ({ ...root, pid, ppid: 1 }))).toBeNull();
    expect(await verifyTerminalDescendant(root, { ...leaf, uid: 502 }, read)).toBeNull();
    expect(await verifyTerminalDescendant(root, { ...leaf, gid: 21 }, read)).toBeNull();
    expect(await verifyTerminalDescendant(root, leaf, async pid => { if (pid === root.pid) throw new Error("exited"); return leaf; })).toBeNull();
  });
  it("rejects a changed captured start and a reparent during the second observation", async () => {
    expect(await verifyTerminalDescendant({ ...root, start: "999" }, leaf, read)).toBeNull();
    let reads = 0;
    expect(await verifyTerminalDescendant(root, leaf, async pid => { if (pid === leaf.pid && ++reads > 1) return { ...leaf, ppid: 1 }; return read(pid); })).toBeNull();
  });
  it("bounds ancestry cycles", async () => {
    let reads = 0;
    expect(await verifyTerminalDescendant(root, leaf, async pid => { reads++; return { ...leaf, pid, ppid: pid + 1 }; })).toBeNull();
    expect(reads).toBe(64);
  });
  it("parses kernel stat comm with parentheses and rejects zombie/privilege transitions", () => {
    const fields = ["S", "20", ...Array(17).fill("0"), "1000", "0"];
    const status = "Uid:\t501\t501\t501\t501\nGid:\t20\t20\t20\t20\n";
    const stat = `40 (a ) tricky) ${fields.join(" ")}`;
    expect(parseLinuxProcess(40, stat, status)).toEqual(root);
    expect(() => parseLinuxProcess(40, stat.replace(") S", ") Z"), status)).toThrow();
    expect(() => parseLinuxProcess(40, stat, status.replace("501\t501", "501\t0"))).toThrow();
  });
});
