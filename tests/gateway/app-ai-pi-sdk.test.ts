import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createPiSdkAppCompletion } from "../../packages/gateway/src/app-ai/pi-sdk-completion.js";
const cleanupFault = vi.hoisted(() => ({ failNext: false, scratch: undefined as string | undefined }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (cleanupFault.failNext && typeof args[0] === "string" && basename(args[0]).startsWith("matrix-app-ai-pi-sdk-")) {
      cleanupFault.failNext = false; cleanupFault.scratch = args[0];
      throw Object.assign(new Error("synthetic cleanup denial"), { code: "EACCES" });
    }
    return fs.rm(...args);
  } };
});
let home: string;
let fixture: string;
let release: ReturnType<typeof vi.fn>;
let acquire: ReturnType<typeof vi.fn>;
const input = () => ({ providerId: "openai", modelId: "openai:fixture", prompt: "Summarize this", signal: AbortSignal.timeout(2000), revalidate: async () => true });
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-app-sdk-test-"));
  await mkdir(join(home, ".pi/agent"), { recursive: true });
  await writeFile(join(home, ".pi/agent/auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-only" } }));
  fixture = join(home, "sdk.mjs");
  release = vi.fn(async () => {}); acquire = vi.fn(async () => release);
  await writeFile(fixture, `
import { readFile,writeFile } from 'node:fs/promises';
export class FileAuthStorageBackend {
 constructor(path){this.path=path;this.chain=Promise.resolve();}
 withLockAsync(fn){const run=this.chain.then(async()=>{const value=await fn(await readFile(this.path,'utf8'));if(value.next!==undefined)await writeFile(this.path,value.next);return value.result;});this.chain=run.catch(error=>{const safeNames=['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'];console.warn('[fixture] credential queue reset',error instanceof Error&&safeNames.includes(error.name)?error.name:'UnknownError');});return run;}
}
export class ModelRuntime {
 static async create(options){if(options.refreshOnCreate!==false||options.allowModelNetwork!==false)throw Error('network catalogs');const runtime=new ModelRuntime();runtime.options=options;return runtime;}
 getError(){return undefined;}
 getPhysicalModel(provider,id){return id==='fixture'?{provider,id,api:'openai-completions',baseUrl:'https://api.openai.com/v1',maxTokens:8192}:undefined;}
 async getAuth(model){const current=await this.options.credentials.read(model.provider);if(!current)return undefined;return {auth:{apiKey:current.key}};}
 async completeSimple(model,context,options){
 if(context.tools.length||options.toolChoice!=='none'||options.maxRetries!==0)throw Error('tools enabled');options.onPayload({model:model.id,tool_choice:'none'});
 if(process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS||process.env.PI_CODING_AGENT_DIR?.includes('owner'))throw Error('ambient context');
 const credential=await this.options.credentials.read(model.provider);
 if(credential?.key!=='fixture-only')throw Error('wrong account');
 return {role:'assistant',provider:model.provider,model:model.id,stopReason:'stop',content:[{type:'text',text:'summary'}]};
 }
}
`);
});
afterEach(async () => {
  cleanupFault.failNext = false;
  if (cleanupFault.scratch) await rm(cleanupFault.scratch, { recursive: true, force: true });
  cleanupFault.scratch = undefined;
  await rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
function adapter() { return createPiSdkAppCompletion({ homePath: home, writer: { acquire }, discover: async () => ({ node: process.execPath, entry: pathToFileURL(fixture).href, env: { OPENAI_API_KEY: "must-strip", NODE_OPTIONS: "must-strip" }, cwd: home }) }); }
it("bounds unfinished credential updates and drains every admitted update before releasing the fence", async () => {
  const admitted = join(home, "admitted.json");
  const unblock = join(home, "unblock");
  const completed = join(home, "completed.json");
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("async getAuth(model){", `async getAuth(model){
    let accepted=0,rejected=false,finished=0;
    for(let i=0;i<17;i++){
      try{this.options.credentials.modify(model.provider,async current=>{
        if(i===0)while(true){try{await readFile(${JSON.stringify(unblock)});break;}catch(error){if(!(error instanceof Error)||error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,10));}}
        await writeFile(${JSON.stringify(completed)},JSON.stringify(++finished));return current;
      });accepted++;}
      catch(error){console.warn('[fixture] credential admission failed',error instanceof Error&&error.name==='Error'?'Error':'UnknownError');rejected=true;break;}
    }
    await writeFile(${JSON.stringify(admitted)},JSON.stringify({accepted,rejected}));throw Error('fixture stopped');`));
  const value = adapter(); let settled = false;
  const generated = value.generate({ ...input(), signal: AbortSignal.timeout(5000) }).catch(error => { settled = true; return error; });
  try {
    await vi.waitFor(async () => { expect(JSON.parse(await readFile(admitted, "utf8"))).toEqual({ accepted: 16, rejected: true }); });
    expect(settled).toBe(false); expect(release).not.toHaveBeenCalled();
    await writeFile(unblock, "release");
    expect(await generated).toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(completed, "utf8"))).toBe(16);
    expect(release).toHaveBeenCalledOnce();
  } finally { await writeFile(unblock, "release"); await generated; await value.close(); }
});
it("reclaims settled credential update slots for subsequent batches", async () => {
  const completed = join(home, "completed.json");
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("async getAuth(model){", `async getAuth(model){
    let finished=0;
    for(let batch=0;batch<2;batch++)await Promise.all(Array.from({length:16},()=>this.options.credentials.modify(model.provider,async current=>{
      await writeFile(${JSON.stringify(completed)},JSON.stringify(++finished));return current;
    })));`));
  const value = adapter();
  try {
    expect(await value.generate(input())).toEqual({ text: "summary" });
    expect(JSON.parse(await readFile(completed, "utf8"))).toBe(32);
    expect(release).toHaveBeenCalledOnce();
  } finally { await value.close(); }
});
it("releases the real durable fence after a failed spawn and permits a fresh launch", async () => {
  const discover = vi.fn()
    .mockResolvedValueOnce({ node: join(home, "missing-node"), entry: pathToFileURL(fixture).href, env: {}, cwd: home })
    .mockResolvedValue({ node: process.execPath, entry: pathToFileURL(fixture).href, env: {}, cwd: home });
  const value = createPiSdkAppCompletion({ homePath: home, discover });
  try {
    await expect(value.generate(input())).rejects.toThrow("App AI");
    await expect(readFile(join(dirname(home), ".matrix-private", basename(home), "native-writers/pi.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await value.generate(input())).toEqual({ text: "summary" });
    expect(discover).toHaveBeenCalledTimes(2);
  } finally { await value.close(); }
});
it("permits another SDK request after scratch cleanup fails following a drained worker", async () => {
  const value = adapter(); cleanupFault.failNext = true;
  try {
    await expect(value.generate(input())).rejects.toThrow("synthetic cleanup denial");
    expect(cleanupFault.scratch).toBeDefined(); expect(release).toHaveBeenCalledOnce();
    expect(await value.generate(input())).toEqual({ text: "summary" });
    expect(acquire).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
  } finally { await value.close(); }
});
it("executes only exact model and selected credential with zero tools and releases the lease", async () => {
  const value = adapter();
  try { expect(await value.generate(input())).toEqual({ text: "summary" }); }
  finally { await value.close(); }
  expect(acquire).toHaveBeenCalledWith("pi"); expect(release).toHaveBeenCalledOnce();
});
it("probes supported selected models without invoking inference or refresh", async () => {
  const value = adapter();
  expect(await value.supports({ ...input(), modelId: "openai:unknown" })).toBe(false);
  expect(await value.supports(input())).toBe(true);
  await value.close();
});
it("rejects shell-backed credentials without executing them", async () => {
  await writeFile(join(home, ".pi/agent/auth.json"), JSON.stringify({ openai: { type: "api_key", key: "!touch should-never-exist" } }));
  const value = adapter();
  await expect(value.generate(input())).rejects.toThrow("App AI"); await value.close();
  expect(release).toHaveBeenCalledOnce();
});
it("checks authorization after credential waiting and after inference", async () => {
  const value = adapter(); const revalidate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(value.generate({ ...input(), revalidate })).rejects.toThrow("App AI"); await value.close();
  expect(revalidate).toHaveBeenCalledTimes(2);
});
it("rejects tools, partial output, wrong model and oversized output", async () => {
  for (const replacement of ["stopReason:'toolUse'", "model:'another'", "content:[{type:'toolCall',id:'x',name:'read',arguments:{}}]", "content:[{type:'text',text:'x'.repeat(64001)}]"]) {
    const source = await readFile(fixture, "utf8");
    await writeFile(fixture, source.replace("stopReason:'stop',content:[{type:'text',text:'summary'}]", `${replacement},stopReason:${replacement.startsWith("stopReason") ? "'toolUse'" : "'stop'"}`));
    const value = adapter(); await expect(value.generate(input())).rejects.toThrow("App AI"); await value.close();
    await writeFile(fixture, source);
  }
});
it("fails closed for unavailable installed SDK and revoked prelaunch access", async () => {
  const value = createPiSdkAppCompletion({ homePath: home, writer: { acquire }, discover: async () => { throw Error("unsupported version"); } });
  expect(await value.supports(input())).toBe(false);
  await expect(value.generate(input())).rejects.toThrow("App AI"); await value.close();
  const second = adapter(); await expect(second.generate({ ...input(), revalidate: async () => false })).rejects.toThrow("App AI"); await second.close();
});
it("cancels an idle SDK and confirms real child exit before lease release", async () => {
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("return {role:'assistant'", "await new Promise(resolve=>setTimeout(resolve,10000));return {role:'assistant'"));
  const value = adapter(); const abort = new AbortController();
  const generated = value.generate({ ...input(), signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await expect(generated).rejects.toThrow("App AI"); await value.close();
  expect(release).toHaveBeenCalledOnce();
});
it("preserves exact custom physical model configuration and refuses credential overlays", async () => {
  await writeFile(join(home, ".pi/agent/models.json"), JSON.stringify({ providers: { openai: { models: [{ id: "fixture", api: "openai-completions", baseUrl: "https://api.openai.com/v1" }] } } }));
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("const runtime=new ModelRuntime();", "if(!(await readFile(options.modelsPath,'utf8')).includes('fixture'))throw Error('missing config');const runtime=new ModelRuntime();"));
  const value = adapter(); expect(await value.generate(input())).toEqual({ text: "summary" }); await value.close();
  await writeFile(join(home, ".pi/agent/models.json"), JSON.stringify({ providers: { openai: { apiKey: "another-account" } } }));
  const second = adapter(); expect(await second.supports(input())).toBe(false); await second.close();
});
it("bounds concurrent admission and prevents execution after shutdown", async () => {
  let unlock!: () => void;
  const blocked = new Promise<void>(resolve => { unlock = resolve; });
  acquire.mockImplementation(async () => { await blocked; return release; });
  const value = adapter(); const first = value.generate(input());
  await expect(value.generate(input())).rejects.toThrow("App AI");
  unlock(); await first; await value.close();
  await expect(value.generate(input())).rejects.toThrow("App AI");
});
it("preserves Unicode across child stream chunk boundaries", async () => {
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("text:'summary'", "text:'🍎'.repeat(20000)"));
  const value = adapter();
  try { expect((await value.generate(input())).text === "🍎".repeat(20000)).toBe(true); }
  finally { await value.close(); }
});
it("refuses credential/account replacement while inference is waiting", async () => {
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, source.replace("return {role:'assistant'", `await writeFile(${JSON.stringify(join(home, ".pi/agent/auth.json"))},JSON.stringify({openai:{type:'api_key',key:'another-account'}}));return {role:'assistant'`));
  const value = adapter(); await expect(value.generate(input())).rejects.toThrow("App AI"); await value.close();
});
it("withholds completed text when the final app grant is revoked", async () => {
  const source = await readFile(fixture, "utf8");
  const completedPath = join(home, "completed.json");
  await writeFile(fixture, source.replace("return {role:'assistant'", `await writeFile(${JSON.stringify(completedPath)},'completed');return {role:'assistant'`));
  const revalidate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const value = adapter();
  await expect(value.generate({ ...input(), revalidate })).rejects.toThrow("App AI");
  await value.close();
  expect(await readFile(completedPath, "utf8")).toBe("completed");
  expect(revalidate).toHaveBeenCalledTimes(3);
});
it("batches exact model readiness in one SDK worker without invoking inference", async () => {
  const value = adapter();
  expect(await value.probe({ providerId: "openai", modelIds: ["openai:fixture", "openai:unknown"], signal: AbortSignal.timeout(2000), revalidate: async () => true })).toEqual(["openai:fixture"]);
  expect(acquire).toHaveBeenCalledOnce(); await value.close();
});

it.each(["auto", {type:"auto"}, {type:"any"}, {type:"tool",name:"read"}, {type:"none",name:"read"}])("denies every non-exact no-tools payload representation", async choice=>{
  const source=await readFile(fixture,"utf8");await writeFile(fixture,source.replace("tool_choice:'none'",`tool_choice:${JSON.stringify(choice)}`));
  const value=adapter();await expect(value.generate(input())).rejects.toThrow("App AI");await value.close();
});
it("denies non-array provider tool definitions", async()=>{
  const source=await readFile(fixture,"utf8");await writeFile(fixture,source.replace("tool_choice:'none'","tool_choice:'none',tools:{read:{}}"));
  const value=adapter();await expect(value.generate(input())).rejects.toThrow("App AI");await value.close();
});
it.each(['crash', 'signal'])('retains the durable fence if the worker exits by %s during credential persistence', async kind => {
  const started = join(home, 'refresh-started');
  const source = await readFile(fixture, 'utf8');
  await writeFile(fixture, source.replace('async getAuth(model){', `async getAuth(model){await this.options.credentials.modify(model.provider,async current=>{await writeFile(${JSON.stringify(started)},'started');${kind === 'crash' ? 'process.exit(2)' : "process.kill(process.pid,'SIGKILL')"};return current;});`));
  const value=adapter();await expect(value.generate(input())).rejects.toThrow('App AI');await value.close();expect(await readFile(started,'utf8')).toBe('started');expect(release).not.toHaveBeenCalled();
});
it('retains the fence when credential mutation rejects because token persistence may be uncertain', async () => {
  const source=await readFile(fixture,'utf8');await writeFile(fixture,source.replace('async getAuth(model){',"async getAuth(model){await this.options.credentials.modify(model.provider,async()=>{throw Error('synthetic refresh failed');});"));
  const value=adapter();await expect(value.generate(input())).rejects.toThrow('App AI');await value.close();expect(release).not.toHaveBeenCalled();
});
