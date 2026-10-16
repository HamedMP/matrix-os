import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { DatabaseExporter } from "./routes.js";

const ERROR = "Database export unavailable";
const MAX_BYTES = 512 * 1024 * 1024;
const DEADLINE = 300_000;
type DumpProcess = Pick<ChildProcess,"once"|"on"|"removeListener"|"kill"> & {stdout:Readable;stderr:Readable};
type SpawnDump = (command:string,args:string[],options:{env:NodeJS.ProcessEnv;stdio:["ignore","pipe","pipe"]})=>DumpProcess;

export function createDatabaseExporter(options:{
  databaseUrl:string;
  spawn?:SpawnDump;
  maxBytes?:number;
  timeoutMs?:number;
}):DatabaseExporter & {close():Promise<void>} {
  const url=new URL(options.databaseUrl);
  // Dedicated VPS database only. No libpq URL options, DNS, arbitrary socket
  // paths, platform DB names or caller-provided arguments enter this process.
  if (!["postgres:","postgresql:"].includes(url.protocol) || !["127.0.0.1","localhost"].includes(url.hostname)
    || url.pathname !== "/matrix" || url.search || url.hash || url.username !== "matrix" || !url.password) throw new Error(ERROR);
  const port=Number(url.port || 5432);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error(ERROR);
  const username=decodeURIComponent(url.username);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(username)) throw new Error(ERROR);
  const maxBytes=options.maxBytes ?? MAX_BYTES;
  const timeoutMs=options.timeoutMs ?? DEADLINE;
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>DEADLINE) throw new Error(ERROR);
  const spawn=options.spawn ?? (nodeSpawn as SpawnDump);
  let closed=false;
  let current:{stop():void;done:Promise<void>}|null=null;
  return {
    async export(signal) {
      if (closed || current || signal.aborted) throw new Error(ERROR);
      // VPS installers provide this system-owned client. The gateway PATH also
      // includes owner-writable tool directories; never give a shim its password.
      const child=spawn("/usr/bin/pg_dump",["--format=custom","--no-owner","--no-acl","--no-password",
        "--exclude-schema=_matrix_owner_access", "--host=127.0.0.1",`--port=${port}`,`--username=${username}`,"--dbname=matrix"],{
        env:{PATH:"/usr/bin:/bin",PGPASSWORD:decodeURIComponent(url.password),
          PGCONNECT_TIMEOUT:"10",PGOPTIONS:"-c statement_timeout=240000 -c lock_timeout=10000"},
        stdio:["ignore","pipe","pipe"],
      });
      let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
      let bytes=0,ended=false;
      let complete!:()=>void;
      const done=new Promise<void>(resolve=>{complete=resolve;});
      const unavailable=()=>new Error(ERROR);
      const fail=()=>{
        if (ended) return;
        ended=true;
        controller?.error(unavailable());
        child.kill("SIGKILL");
      };
      const active={stop:fail,done};
      current=active;
      const timer=setTimeout(fail,timeoutMs);timer.unref();
      const cleanup=()=>{
        clearTimeout(timer);signal.removeEventListener("abort",fail);
        if (current===active) current=null;
        complete();
      };
      child.stderr.resume(); // Never buffer or return provider stderr/credentials.
      child.once("close",(code:number|null)=>{
        if (!ended) {
          ended=true;
          if(code===0 && bytes>0) controller?.close();
          else controller?.error(unavailable());
        }
        cleanup();
      });
      child.once("error",()=>{fail();cleanup();});
      signal.addEventListener("abort",fail,{once:true});
      const stream=new ReadableStream<Uint8Array>({
        start(c) {
          controller=c;
          child.stdout.on("data",(chunk:Buffer)=>{
            if(ended)return;
            bytes+=chunk.length;
            if(bytes>maxBytes){fail();return;}
            c.enqueue(new Uint8Array(chunk));
            if((c.desiredSize ?? 0)<=0)child.stdout.pause();
          });
          child.stdout.once("error",fail);
          if(signal.aborted)fail();
        },
        pull(){if(!ended)child.stdout.resume();},
        cancel(){fail();},
      },{highWaterMark:256*1024,size:chunk=>chunk.byteLength});
      try {
        await new Promise<void>((resolve,reject)=>{
          child.once("spawn",resolve);
          child.once("error",()=>reject(unavailable()));
          child.once("close",()=>{if(ended)reject(unavailable());});
        });
      } catch(error:unknown) {fail();throw error;}
      return new Response(stream);
    },
    async close() {
      closed=true;
      const active=current;
      if(active){active.stop();await active.done;}
    },
  };
}
