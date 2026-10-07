import { mkdtemp, readFile, writeFile, mkdir, symlink, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailObjectStore, mailObjectNamespace } from "../../packages/gateway/src/mail/objects.js";
describe.skipIf(process.platform !== "linux")("private retained mail objects", () => {
  let home: string;
  let store: MailObjectStore;
  const namespace = mailObjectNamespace("owner", "gmail", "conn");
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mail-object-test-")); store = new MailObjectStore(home); });
  afterEach(async () => { await store.destroy(); await rm(home, { recursive: true, force: true }); });
  it("writes immutable owner-only bytes and validates digest", async () => {
    const object = await store.put(namespace, Buffer.from("hello"));
    expect(await store.read(object)).toEqual(Buffer.from("hello"));
    expect(await store.put(namespace, Buffer.from("hello"))).toEqual(object);
    expect((await stat(join(home, "mail", "objects", namespace, object.digest))).mode & 0o777).toBe(0o600);
    await writeFile(join(home, "mail", "objects", namespace, object.digest), "broken");
    await expect(store.read(object)).rejects.toThrow(/integrity/i);
  });
  it("rejects traversal, excessive bodies, and symlinked ancestors", async () => {
    await expect(store.put("../outside", Buffer.from("a"))).rejects.toThrow();
    await expect(store.put(namespace, Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toThrow();
    const outside = join(home, "outside"); await mkdir(outside); await symlink(outside, join(home, "mail"));
    await expect(store.put(namespace, Buffer.from("a"))).rejects.toThrow();
  });
  it("rejects symlinked objects and skips them during sweep", async () => {
    const object = await store.put(namespace, Buffer.from("hello"));
    const path = join(home, "mail", "objects", namespace, object.digest);
    await rm(path); await writeFile(join(home, "elsewhere"), "hello"); await symlink(join(home, "elsewhere"), path);
    await expect(store.read(object)).rejects.toThrow();
    expect(await store.sweep({ olderThan: new Date(Date.now() + 1), maxCount: 100, reclaim: async (_namespace, _digest, remove) => { await remove(); return true; } })).toBe(0);
    expect(await readFile(join(home, "elsewhere"), "utf8")).toBe("hello");
  });
  it("uses reference/lease claim callback before bounded orphan removal", async () => {
    const object = await store.put(namespace, Buffer.from("hello"));
    expect(await store.sweep({ olderThan: new Date(Date.now() + 1), maxCount: 10, reclaim: async () => false })).toBe(0);
    expect(await store.read(object)).toEqual(Buffer.from("hello"));
    expect(await store.sweep({ olderThan: new Date(Date.now() + 1), maxCount: 10, reclaim: async (_namespace, _digest, remove) => { await remove(); return true; } })).toBe(1);
    await expect(store.read(object)).rejects.toThrow();
  });
  it("continues bounded GC beyond referenced objects on later runs", async () => {
    const objects = [];
    for (let index=0; index<8; index++) objects.push(await store.put(namespace,Buffer.from(`object-${index}`)));
    let examined=0,removed=0;
    const options = { olderThan:new Date(Date.now()+10),maxCount:2,reclaim:async (_namespace:string,_digest:string,remove:()=>Promise<void>)=>{ examined++; if(examined<=3)return false; await remove(); return true; } };
    for(let index=0;index<8;index++) removed+=await store.sweep(options);
    expect(examined).toBeGreaterThanOrEqual(8); expect(removed).toBeGreaterThanOrEqual(5);
  });
  it("drains retained directory capabilities on shutdown", async () => {
    await store.put(namespace,Buffer.from("hello"));
    const options = { olderThan:new Date(Date.now()+1),maxCount:1,reclaim:async()=>false,onError:()=>{} };
    await store.sweep(options);
    const stop=store.startSweep(options); await stop();
    await store.destroy();
    expect(await store.sweep({ ...options,maxCount:10 })).toBe(0);
  });
});

if (process.platform !== "linux") it("fails closed without Linux directory capabilities", async () => {
  await expect(new MailObjectStore("/tmp").put(namespaceForPlatform(), Buffer.from("mail"))).rejects.toThrow(/unavailable/);
});
function namespaceForPlatform() { return mailObjectNamespace("owner", "gmail", "conn"); }
