import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { createPiSdkAppCompletion } from "../../packages/gateway/src/app-ai/pi-sdk-completion.js";
// Explicit opt-in to an installed pinned public SDK. Always use empty temporary
// profiles and a stub transport; never consult customer auth or make paid calls.
const entry = process.env.MATRIX_PI_SDK_TEST_ENTRY;
it.skipIf(!entry)("real public SDK sends exact physical model without tools and persists OAuth rotation under its native lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-pi-public-sdk-spike-"));
  const evidence = join(home, "evidence.json");
  const authPath = join(home, ".pi/agent/auth.json");
  const refreshes = join(home, "refreshes.txt");
  let adapter: ReturnType<typeof createPiSdkAppCompletion> | undefined;
  try {
    await mkdir(join(home, ".pi/agent"), { recursive: true });
    await writeFile(authPath, JSON.stringify({ openai: { type: "oauth", accountId: "fixture-account", access: "fixture-old", refresh: "fixture-old-refresh", expires: 1 } }));
    await writeFile(join(home, ".pi/agent/models.json"), JSON.stringify({ providers: { openai: { models: [{ id: "fixture", name: "Fixture", api: "openai-completions", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 }] } } }));
    const wrapper = join(home, "sdk.mjs");
    await writeFile(wrapper, `
import {ModelRuntime as RealRuntime} from ${JSON.stringify(entry)};
export {FileAuthStorageBackend} from ${JSON.stringify(new URL("./core/auth-storage.js", entry).href)};
import {writeFile,readFile,appendFile} from 'node:fs/promises';
export class ModelRuntime {
 static async create(options){
  const runtime=await RealRuntime.create(options);
  const provider=runtime.getProvider('openai');
  runtime.registerNativeProvider({...provider,auth:{...provider.auth,oauth:{name:'Fixture only',
   refresh:async(current,signal)=>{signal.throwIfAborted();await appendFile(${JSON.stringify(refreshes)},'refresh\\n');await new Promise(resolve=>setTimeout(resolve,250));return {...current,access:'fixture-new',refresh:'fixture-new-refresh',expires:Date.now()+3600000};},
   toAuth:async(current)=>({apiKey:current.access})
  }}});
  const original=runtime.completeSimple.bind(runtime);
  runtime.completeSimple=(model,context,request)=>original(model,context,{...request,fetch:async(url,init)=>{
   const body=JSON.parse(init.body);
   if(body.tools?.length||body.functions?.length||body.tool_choice&&body.tool_choice!=='none'&&!(body.tool_choice?.type==='none'&&Object.keys(body.tool_choice).length===1))throw Error('tools');
   if(body.model!=='fixture')throw Error('model');
   const auth=JSON.parse(await readFile(${JSON.stringify(authPath)},'utf8'));
   if(auth.openai.refresh!=='fixture-new-refresh')throw Error('rotation not persisted');
   await writeFile(${JSON.stringify(evidence)},JSON.stringify({model:body.model,tools:body.tools??[],messages:body.messages,rotated:true}));
   if(model.api==='anthropic-messages'){
    const events=[['message_start',{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'real SDK summary'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}}],['message_stop',{type:'message_stop'}]];
    return new Response(events.map(([name,event])=>'event: '+name+'\\n'+'data: '+JSON.stringify(event)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
   }
   const events=[{id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'real SDK summary'},finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
   return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
  }});
  return runtime;
 }
}
`);
    adapter = createPiSdkAppCompletion({ homePath: home, discover: async () => ({ node: process.execPath, entry: pathToFileURL(wrapper).href, env: {}, cwd: home }) });
    const input = { providerId: "openai", modelId: "openai:fixture", prompt: "Only supplied text", signal: AbortSignal.timeout(10000), revalidate: async () => true };
    expect(await adapter.supports(input)).toBe(true);
    // Discovery did not exchange/refresh OAuth.
    expect(JSON.parse(await readFile(authPath, "utf8")).openai.refresh).toBe("fixture-old-refresh");
    expect(await adapter.generate(input)).toEqual({ text: "real SDK summary" });
    expect(JSON.parse(await readFile(evidence, "utf8"))).toMatchObject({ model: "fixture", tools: [], rotated: true });
    expect(JSON.parse(await readFile(authPath, "utf8")).openai.refresh).toBe("fixture-new-refresh");
    expect((await readFile(refreshes, "utf8")).trim().split("\n")).toHaveLength(1);
    // Two real worker processes share the native SDK lock, even when callers
    // use independent Matrix admission (fixture-only bypass).
    await writeFile(authPath, JSON.stringify({ openai: { type: "oauth", accountId: "fixture-account", access: "fixture-old", refresh: "fixture-old-refresh", expires: 1 } }));
    const writer = { acquire: async () => async () => {} };
    const discovery = async () => ({ node: process.execPath, entry: pathToFileURL(wrapper).href, env: {}, cwd: home });
    const first = createPiSdkAppCompletion({ homePath: home, writer, discover: discovery });
    const second = createPiSdkAppCompletion({ homePath: home, writer, discover: discovery });
    try { expect(await Promise.all([first.generate(input), second.generate(input)])).toEqual([{ text: "real SDK summary" }, { text: "real SDK summary" }]); }
    finally { await first.close(); await second.close(); }
    expect((await readFile(refreshes, "utf8")).trim().split("\n")).toHaveLength(2);
    // Cancellation after rotation starts still persists the only valid token
    // before releasing Matrix's writer fence.
    await writeFile(authPath, JSON.stringify({ openai: { type: "oauth", accountId: "fixture-account", access: "fixture-old", refresh: "fixture-old-refresh", expires: 1 } }));
    const release = vi.fn(async () => {});
    const cancelled = createPiSdkAppCompletion({ homePath: home, writer: { acquire: async () => release }, discover: discovery });
    const abort = new AbortController();
    const generated = cancelled.generate({ ...input, signal: abort.signal });
    for (let attempts = 0; attempts < 100; attempts++) {
      if ((await readFile(refreshes, "utf8")).trim().split("\n").length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    abort.abort();
    await expect(generated).rejects.toThrow("App AI");
    await cancelled.close();
    expect(JSON.parse(await readFile(authPath, "utf8")).openai.refresh).toBe("fixture-new-refresh");
    expect(release).toHaveBeenCalledOnce();
    // Anthropic uses a structured no-tools representation on the real wire.
    const auth=JSON.parse(await readFile(authPath,"utf8"));auth.anthropic={type:"api_key",key:"fixture-only"};await writeFile(authPath,JSON.stringify(auth));
    await writeFile(join(home,".pi/agent/models.json"),JSON.stringify({providers:{anthropic:{models:[{id:"fixture",api:"anthropic-messages",baseUrl:"https://api.anthropic.com",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:8192}]}}}));
    expect(await adapter.generate({...input,providerId:"anthropic",modelId:"anthropic:fixture"})).toEqual({text:"real SDK summary"});
  } finally { await adapter?.close(); await rm(home, { recursive: true, force: true }); }
});
