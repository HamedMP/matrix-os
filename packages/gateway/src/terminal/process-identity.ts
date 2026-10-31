import { constants } from "node:fs";
import { open } from "node:fs/promises";
export interface LinuxProcessIdentity { pid: number; ppid: number; uid: number; gid: number; start: string }
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
async function boundedRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(16385), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead >= bytes.length) throw new Error("Terminal process proof unavailable");
    return bytes.toString("utf8", 0, bytesRead);
  } finally { await file.close(); }
}
export function parseLinuxProcess(pid: number, stat: string, status: string): LinuxProcessIdentity {
  if (!validPid(pid) || !stat.startsWith(`${pid} (`)) throw new Error("Terminal process proof unavailable");
  const boundary = stat.lastIndexOf(") "), fields = stat.slice(boundary + 2).trim().split(/\s+/);
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  // Reject zombie/dead processes and privilege transitions; real/effective/saved/fs IDs must agree.
  if (boundary < 3 || !["R", "S", "D", "T", "t", "I"].includes(fields[0] ?? "")
    || !uid || !gid || new Set(uid.slice(1)).size !== 1 || new Set(gid.slice(1)).size !== 1
    || !/^\d+$/.test(fields[1] ?? "") || !/^[1-9]\d*$/.test(fields[19] ?? "")) throw new Error("Terminal process proof unavailable");
  const identity = { pid, ppid: Number(fields[1]), uid: Number(uid[1]), gid: Number(gid[1]), start: fields[19]! };
  if (![identity.ppid, identity.uid, identity.gid].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647)) throw new Error("Terminal process proof unavailable");
  return Object.freeze(identity);
}
export function sameProcess(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean {
  return left.pid === right.pid && left.uid === right.uid && left.gid === right.gid && left.start === right.start;
}
export async function readLinuxProcess(pid: number): Promise<LinuxProcessIdentity> {
  if (process.platform !== "linux" || !validPid(pid)) throw new Error("Terminal process proof unavailable");
  const base = `/proc/${pid}`;
  const first = await boundedRead(`${base}/stat`), status = await boundedRead(`${base}/status`), second = await boundedRead(`${base}/stat`);
  const identity = parseLinuxProcess(pid, first, status), after = parseLinuxProcess(pid, second, status);
  if (!sameProcess(identity, after) || identity.ppid !== after.ppid) throw new Error("Terminal process proof unavailable");
  return identity;
}
/** Bounded ancestry with repeated start checks. A saved start mismatch is NOT a PID-reuse experiment. */
export async function verifyTerminalDescendant(root: LinuxProcessIdentity, writer: { pid: number; uid: number; gid: number }, read = readLinuxProcess): Promise<LinuxProcessIdentity | null> {
  if (writer.uid !== root.uid || writer.gid !== root.gid || !validPid(writer.pid)) return null;
  const chain: LinuxProcessIdentity[] = []; // <=64, per-invocation only.
  try {
    let current = writer.pid;
    for (let depth = 0; depth < 64; depth++) {
      const identity = await read(current);
      if (identity.uid !== root.uid || identity.gid !== root.gid || chain.some(entry => entry.pid === identity.pid)) return null;
      chain.push(identity);
      if (identity.pid === root.pid) {
        if (!sameProcess(root, identity)) return null;
        for (const entry of chain) { const after = await read(entry.pid); if (!sameProcess(entry, after) || entry.ppid !== after.ppid) return null; }
        return chain[0]!;
      }
      if (!validPid(identity.ppid)) return null;
      current = identity.ppid;
    }
    return null;
  } catch (error) {
    console.warn("[terminal-proof] Process observation unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
