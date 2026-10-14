import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SYNTHETIC_MCP_SOURCE, createProbeClient } from "../../scripts/spikes/browser-vps/codex-mcp-probe-support.mjs";
it("generates valid MCP JavaScript and returns actual newline-delimited JSON",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"matrix-probe-source-"));
  try{const path=join(dir,"mock.mjs");await writeFile(path,SYNTHETIC_MCP_SOURCE);
    const child=spawn(process.execPath,[path],{env:{PATH:process.env.PATH,MATRIX_SYNTHETIC_MARKER:"synthetic-A"},stdio:["pipe","pipe","pipe"]});
    const closed=new Promise<number|null>((resolve,reject)=>{child.once("close",resolve);child.once("error",reject);});
    let output="",error="";child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{error+=chunk;});
    child.stdin.end(JSON.stringify({id:1,method:"tools/list"})+"\n");expect(await closed,error).toBe(0);
    expect(output.endsWith("\n")).toBe(true);expect(output.split("\n")).toHaveLength(2);
    expect(JSON.parse(output)).toMatchObject({id:1,result:{tools:[{description:"synthetic-A"}]}});
  }finally{await rm(dir,{recursive:true,force:true});}
});
function fakeChild(){const child=new EventEmitter() as never;Object.assign(child,{stdout:new PassThrough(),stdin:new PassThrough(),kill:vi.fn()});return child;}
it("settles pending requests on native exit and refuses further requests",async()=>{
  const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:50,totalTimeoutMs:100});
  const waiting=expect(client.request("initialize",{})).rejects.toThrow("Native probe unavailable");child.emit("close",1);await waiting;
  await expect(client.request("thread/start",{})).rejects.toThrow();client.dispose();
});
it("bounds silent native requests and handles spawn errors",async()=>{
  const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:5,totalTimeoutMs:50});
  await expect(client.request("initialize",{})).rejects.toThrow("Native probe request timed out");client.dispose();
  const failed=fakeChild();const c=createProbeClient(failed,{requestTimeoutMs:50,totalTimeoutMs:100});
  const waiting=expect(c.request("initialize",{})).rejects.toThrow("Native probe unavailable");failed.emit("error",new Error("synthetic spawn failure"));await waiting;c.dispose();
});
it("reports the refused stage/method and safe numeric code without upstream text",async()=>{
  const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:50,totalTimeoutMs:100});
  const waiting=expect(client.request("thread/start",{})).rejects.toMatchObject({message:"Native probe RPC refused",method:"thread/start",code:-32602});
  child.stdout.write(JSON.stringify({id:1,error:{code:-32602,message:"synthetic private error detail"}})+"\n");await waiting;client.dispose();
});
it("caps synthetic diagnostic details to 1024 characters",async()=>{
  const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:50,totalTimeoutMs:100});
  const request=client.request("thread/resume",{}).catch((error:Error)=>error);
  child.stdout.write(JSON.stringify({id:1,error:{code:-32600,message:"synthetic "+"x".repeat(2048)}})+"\n");
  const error=await request;expect(error.message).toBe("Native probe RPC refused");expect(error.nativeMessage).toHaveLength(1024);client.dispose();
});
it("rejects oversized newline-free native output before buffering past one MiB",async()=>{
  const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:500,totalTimeoutMs:1000});
  const waiting=expect(client.request("thread/start",{})).rejects.toThrow("Native probe unavailable");
  child.stdout.write(Buffer.alloc(1024*1024+1,0x78));await waiting;
  await expect(client.request("thread/start",{})).rejects.toThrow("Native probe unavailable");client.dispose();
});
it("classifies malformed native JSON without logging provider-controlled text",async()=>{
  const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{
    const child=fakeChild();const client=createProbeClient(child,{requestTimeoutMs:500,totalTimeoutMs:1000});
    const waiting=expect(client.request("thread/start",{})).rejects.toThrow("Native probe unavailable");
    child.stdout.write("{private malformed native output}\n");await waiting;
    expect(warning).toHaveBeenCalledWith("[browser-vps-probe] Native transport rejected", "SyntaxError");client.dispose();
  }finally{warning.mockRestore();}
});
it("writes only a new bounded synthetic rollout with the official session/message envelope",async()=>{
  const { writeSyntheticRollout }=await import("../../scripts/spikes/browser-vps/codex-mcp-probe-support.mjs");
  const { readFile }=await import("node:fs/promises");const dir=await mkdtemp(join(tmpdir(),"matrix-rollout-source-"));
  try{const id="123e4567-e89b-42d3-a456-426614174000";const path=await writeSyntheticRollout({homePath:dir,threadId:id,cwd:dir});
    const records=(await readFile(path,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(records.map(row=>row.type)).toEqual(["session_meta","response_item","event_msg"]);
    expect(records[0].payload).toMatchObject({id,session_id:id,source:"cli",history_mode:"legacy",cli_version:"0.162.1"});
    expect(records[1].payload).toMatchObject({type:"message",role:"user",content:[{type:"input_text",text:"Synthetic MCP lifecycle fixture. No model turn was executed."}]});
    await expect(writeSyntheticRollout({homePath:dir,threadId:id,cwd:dir})).rejects.toMatchObject({code:"EEXIST"});
  }finally{await rm(dir,{recursive:true,force:true});}
});
it("requires confirmed native child exit before another process may start",async()=>{
  const {confirmProbeChildStopped}=await import("../../scripts/spikes/browser-vps/codex-mcp-probe-support.mjs");
  const child=fakeChild();let finish!:()=>void;const closed=new Promise<void>(resolve=>{finish=resolve;});let stopped=false;
  const stopping=confirmProbeChildStopped(child,closed,{forceMs:100,deadlineMs:200}).then(()=>{stopped=true;});
  await Promise.resolve();expect(child.kill).toHaveBeenCalledWith("SIGTERM");expect(stopped).toBe(false);finish();await stopping;expect(stopped).toBe(true);
  const uncertain=fakeChild();await expect(confirmProbeChildStopped(uncertain,new Promise(()=>{}),{forceMs:1,deadlineMs:5})).rejects.toThrow("Synthetic native cleanup unconfirmed");
  expect(uncertain.kill).toHaveBeenCalledWith("SIGKILL");
});
