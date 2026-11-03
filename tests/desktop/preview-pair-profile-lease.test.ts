import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { claimPreviewProfile } from "@desktop/main/preview-pair-profile-lease";
it("prevents concurrent cleanup/startup while the owning process is alive and releases only its own lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "eng418-profile-lease-"));
  try {
    const first = await claimPreviewProfile(root);
    await expect(claimPreviewProfile(root)).rejects.toThrow("in use");
    await first.release(); const next = await claimPreviewProfile(root); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses malformed or untrusted activity files instead of assuming a stopped app", async () => {
  const root = await mkdtemp(join(tmpdir(), "eng418-profile-lease-"));
  try {
    await writeFile(join(root, ".preview-active.json"), "invalid", { mode: 0o600 });
    await expect(claimPreviewProfile(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("recovers a real exited owner once across competing processes without deleting the winning lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "eng418-dead-profile-")), children: ChildProcess[] = [];
  const module = pathToFileURL(resolve("desktop/src/main/preview-pair-profile-lease.ts")).href;
  const common = `import {once} from 'node:events';import {claimPreviewProfile} from ${JSON.stringify(module)};const root=${JSON.stringify(root)};`;
  const args = ["--import", "tsx", "--input-type=module", "--eval"];
  try {
    const orphan = spawnSync(process.execPath, [...args, common + `await claimPreviewProfile(root);process.stdout.write(String(process.pid));process.exit(0);`], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(orphan.status, orphan.stderr).toBe(0);
    const deadPid = Number(orphan.stdout);
    expect(deadPid).toBeGreaterThan(0);
    expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const original = await readFile(join(root, ".preview-active.json"), "utf8");
    expect(JSON.parse(original).pid).toBe(deadPid);
    const contender = common + `
const deadline=setTimeout(()=>process.exit(2),10000);
const go=once(process,'message');process.send({ready:true});await go;
let lease;
try {lease=await claimPreviewProfile(root);}
catch(error){if(!(error instanceof Error))throw error;process.send({owned:false});}
if(lease){const release=once(process,'message');process.send({owned:true});await release;await lease.release();}
clearTimeout(deadline);process.disconnect();`;
    const contenders = [0, 1].map(() => {
      const child = spawn(process.execPath, [...args, contender], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return { child, ready: once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        closed: once(child, "close", { signal: AbortSignal.timeout(10_000) }) };
    });
    await Promise.all(contenders.map(c => c.ready));
    const outcomes = contenders.map(c => once(c.child, "message", { signal: AbortSignal.timeout(10_000) }));
    contenders.forEach(c => c.child.send("claim"));
    const observed = await Promise.all(outcomes);
    const winners = observed.flatMap(([value], index) => value.owned ? [index] : []);
    expect(winners).toHaveLength(1);
    const winner = winners[0], loser = 1 - winner;
    await contenders[loser].closed;
    const owned = await readFile(join(root, ".preview-active.json"), "utf8");
    expect(JSON.parse(owned).pid).toBe(contenders[winner].child.pid);
    expect(owned).not.toBe(original);
    await expect(claimPreviewProfile(root)).rejects.toThrow();
    expect(await readFile(join(root, ".preview-active.json"), "utf8")).toBe(owned);
    contenders[winner].child.send("release");
    expect((await contenders[winner].closed)[0]).toBe(0);
    expect(await readdir(root)).toEqual([]);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : once(child, "close", { signal: AbortSignal.timeout(5_000) })));
    await rm(root, { recursive: true, force: true });
  }
});
