import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMachineSshStore, MACHINE_SSH_FILE_MAX_BYTES } from "@desktop/main/local-terminals/machine-ssh-store";

// Fault detected (Greptile, #3570): Open in terminal for a machine added with a
// port, identity file, jump host or Tailscale SSH lost those options.

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("added machines' ssh fields", () => {
  it("keeps each machine's target and options, fields only, and forgets removed ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-machine-ssh-"));
    dirs.push(dir);
    const store = createMachineSshStore(dir);
    await Promise.all([
      store.set("box", { target: "me@box", ssh: { port: 2222, identity: "~/.ssh/id_box", jump: "me@bastion" } }),
      store.set("ts", { target: "ts-box.tail.ts.net", ssh: { tailscaleSsh: true } }),
    ]);
    expect(await store.get("box")).toEqual({ target: "me@box", ssh: { port: 2222, identity: "~/.ssh/id_box", jump: "me@bastion" } });
    expect(Object.keys(await store.all()).sort()).toEqual(["box", "ts"]);
    await store.remove("box");
    expect(await store.get("box")).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "machine-ssh.json"), "utf8")).version).toBe(1);
  });

  it("ignores a file with entries that are not fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-machine-ssh-"));
    dirs.push(dir);
    await writeFile(join(dir, "machine-ssh.json"), JSON.stringify({ version: 1, machines: { box: { target: "-oProxyCommand=sh" } } }));
    expect(await createMachineSshStore(dir).all()).toEqual({});
  });

  // Fault detected (Greptile, #3570): the whole settings file was buffered with no size limit.
  it("never buffers an oversized file, shows it as empty and never overwrites it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-machine-ssh-"));
    dirs.push(dir);
    const big = JSON.stringify({ version: 1, machines: {}, pad: "x".repeat(MACHINE_SSH_FILE_MAX_BYTES) });
    await writeFile(join(dir, "machine-ssh.json"), big);
    const store = createMachineSshStore(dir);
    expect(await store.all()).toEqual({});
    await expect(store.set("box", { target: "me@box" })).rejects.toThrow();
    expect(await readFile(join(dir, "machine-ssh.json"), "utf8")).toBe(big);
  });
});
