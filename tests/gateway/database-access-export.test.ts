import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createDatabaseExporter } from "../../packages/gateway/src/database-access/export.js";
function child() {
  const p = new EventEmitter() as EventEmitter & {stdout:PassThrough;stderr:PassThrough;kill:(signal?:string)=>boolean};
  p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{queueMicrotask(()=>p.emit("close",null,"SIGKILL"));return true;};
  return p;
}
function setup(maxBytes=1024,timeoutMs=1000) {
  const p=child(); const calls:unknown[][]=[];
  const service=createDatabaseExporter({databaseUrl:"postgresql://matrix:service-secret@127.0.0.1:5432/matrix",maxBytes,timeoutMs,
    spawn:((...args:unknown[])=>{calls.push(args);queueMicrotask(()=>p.emit("spawn"));return p;}) as never});
  return {p,service,calls};
}
afterEach(() => vi.unstubAllEnvs());
describe("database export process lifecycle",()=>{
  it("streams the custom-format dump and keeps service credentials out of args and inherited environment",async()=>{const s=setup();const response=await s.service.export(new AbortController().signal);const read=response.arrayBuffer();s.p.stdout.end("PGDMPcontents");s.p.emit("close",0,null);expect(Buffer.from(await read).toString()).toBe("PGDMPcontents");const [bin,args,options]=s.calls[0] as [string,string[],{env:Record<string,string>}];expect(bin).toBe("/usr/bin/pg_dump");expect(args).toContain("--format=custom");expect(args.join(" ")).not.toContain("service-secret");expect(options.env.PGPASSWORD).toBe("service-secret");expect(options.env.MATRIX_AUTH_TOKEN).toBeUndefined();await s.service.close();});
  it("pauses the dump when the download queue fills and resumes when read",async()=>{const s=setup(1024*1024);const response=await s.service.export(new AbortController().signal);s.p.stdout.write(Buffer.alloc(300_000));await new Promise(resolve=>setTimeout(resolve,0));expect(s.p.stdout.isPaused()).toBe(true);const reader=response.body!.getReader();expect((await reader.read()).value?.byteLength).toBe(300_000);await new Promise(resolve=>setTimeout(resolve,0));expect(s.p.stdout.isPaused()).toBe(false);await reader.cancel();await s.service.close();});
  it("rejects remote, platform and unbounded URL options before spawn",()=>{for(const url of ["postgres://a:b@evil.test/matrix","postgres://a:b@127.0.0.1/platform","postgres://a:b@127.0.0.1/matrix?options=x"]){expect(()=>createDatabaseExporter({databaseUrl:url})).toThrow();}});
  it("allows only one active export and releases after exit",async()=>{const s=setup();const response=await s.service.export(new AbortController().signal);await expect(s.service.export(new AbortController().signal)).rejects.toThrow();await response.body!.cancel();await new Promise(resolve=>setTimeout(resolve,0));await s.service.close();});
  it("fails the download on nonzero exit without returning stderr",async()=>{const s=setup();const response=await s.service.export(new AbortController().signal);const read=response.text();s.p.stderr.write("postgres://private:secret@host");s.p.emit("close",1,null);await expect(read).rejects.toThrow("Database export unavailable");await s.service.close();});
  it("kills and errors an oversized dump",async()=>{const s=setup(4);const response=await s.service.export(new AbortController().signal);const read=response.text();s.p.stdout.write("too much data");await expect(read).rejects.toThrow();await s.service.close();});
  it("cancels an export when the request is aborted",async()=>{const s=setup();const abort=new AbortController();const response=await s.service.export(abort.signal);const read=response.text();abort.abort();await expect(read).rejects.toThrow();await s.service.close();});
  it("times out and drains children on shutdown",async()=>{const s=setup(1024,15);const response=await s.service.export(new AbortController().signal);await expect(response.text()).rejects.toThrow();await s.service.close();await expect(s.service.export(new AbortController().signal)).rejects.toThrow();});
  it("rejects pre-aborted requests without spawning",async()=>{const s=setup();const abort=new AbortController();abort.abort();await expect(s.service.export(abort.signal)).rejects.toThrow();expect(s.calls).toHaveLength(0);await s.service.close();});
  it("never resolves the dump executable or helper tools from owner-writable PATH entries", async () => {
    vi.stubEnv("PATH", "/private/tmp/owner-writable-bin:/usr/bin:/bin");
    const s=setup(); const response=await s.service.export(new AbortController().signal);
    const [bin,,options]=s.calls[0] as [string,string[],{env:Record<string,string>}];
    expect(bin).toBe("/usr/bin/pg_dump");
    expect(options.env.PATH).toBe("/usr/bin:/bin");
    await response.body!.cancel(); await s.service.close();
  });
});
