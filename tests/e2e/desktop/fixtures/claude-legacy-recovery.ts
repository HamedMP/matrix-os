import {createServer, request} from "node:http";
import {connect} from "node:net";
import {Hono} from "hono";
import {BotProviderConnectionsSchema,ProviderSettingsSnapshotSchema} from "@matrix-os/contracts";
import {createNativeProviderWorkflowAdapters} from "../../../../packages/gateway/src/ai-providers/provider-workflow-native";
import {createProviderWorkflowService} from "../../../../packages/gateway/src/ai-providers/provider-workflows";
import {createProviderWorkflowRoutes} from "../../../../packages/gateway/src/ai-providers/provider-workflow-routes";
import type {ProviderSettingsStoreWriter} from "../../../../packages/gateway/src/ai-providers/provider-settings-store";
import {providerAuthSettingsSnapshot, startProviderAuthGateway} from "./provider-auth-gateway";

/** Synthetic account identity and owner store; real native adoption and HTTP workflow routing. */
export async function startClaudeLegacyRecoveryGateway() {
  let adopted = false, revision = 6, completions = 0, browserStarts = 0, terminalStarts = 0;
  let failAdoption = false;
  const snapshot = () => {
    const base = providerAuthSettingsSnapshot(true, true);
    const now = new Date().toISOString();
    return ProviderSettingsSnapshotSchema.parse({...base, revision, refreshedAt:now,
      projectionOf:{...base.projectionOf,revision}, supportedActions:["start_login","logout_account","set_harness_enabled"],
      accounts:base.accounts.map(account=>({...account,displayName:"Fixture Claude account",connectionDetails:{email:"fixture@example.test"},lastCheckedAt:now})),
      accessSources:base.accessSources.map(source=>({...source,readiness:{state:"unknown",checkedAt:null,staleAfter:null,action:"retry",safeReason:"unknown"}})),
      harnesses:base.harnesses.map(harness=>({...harness,id:"harness_kernel",enabled:adopted,configuredEnabled:true,
        configuredAccessSourceId:adopted?"owner_claude_profile":"matrix_included",authState:adopted?"authenticated":"unknown",
        connectivity:"unknown",accessSourceId:adopted?"owner_claude_profile":null,selectedAccountId:adopted?"owner_claude_profile":null})),
    });
  };
  const upstream = await startProviderAuthGateway({settings:snapshot});
  const unavailable = async () => {terminalStarts++;throw new Error("Fixture must not launch a native resource");};
  const adapters = await createNativeProviderWorkflowAdapters({
    store:{getSnapshot:async()=>snapshot(),mutate:unavailable,
      completeClaudeNativeLogin:async input=>{
        if(input.expectedRevision!==revision || input.harnessInstanceId!=="harness_kernel" || failAdoption) throw new Error("Fixture adoption rejected");
        adopted=true;revision++;completions++;
        return {kind:"snapshot",snapshot:snapshot()};
      }} as ProviderSettingsStoreWriter,
    terminal:{ensureWorkspace:unavailable,createTab:unavailable,terminateTab:unavailable,attach:()=>{throw new Error("Unexpected Terminal attach");},listWorkspaces:unavailable},
    runtimePrefix:"/synthetic/claude-recovery-runtime",hostControl:{available:false,run:unavailable},
    claudeBrowserLogin:async()=>{browserStarts++;throw new Error("Existing login must be adopted before OAuth");},
  });
  const service = createProviderWorkflowService({ownerId:"fixture-owner",adapters});
  const routes = new Hono().route("/api/ai",createProviderWorkflowRoutes({service,getPrincipal:()=>({userId:"fixture-owner"})}));
  const server = createServer(async(req,res)=>{
    if(req.method==="GET"&&req.url?.startsWith("/api/bot-connections?")){
      const connections=BotProviderConnectionsSchema.parse({connections:[{id:"claude_code_tasks",providerId:"anthropic",executionKind:"native_task",
        availability:"setup_required",unavailableReason:"authorization_required",models:[{id:"claude-opus-5",displayName:"Claude Opus 5"}],
        authorization:{revision:0,enabled:false,background:false},coordinatorFunding:"separate"}]});
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(connections));return;
    }
    if(req.url?.startsWith("/api/ai/provider-settings/workflows")) {
      try {
        const chunks:Buffer[]=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw new Error("Fixture body limit");chunks.push(Buffer.from(chunk));}
        const response=await routes.request("http://fixture"+req.url,{method:req.method,headers:{"content-type":"application/json"},
          ...(!["GET","HEAD"].includes(req.method??"GET")?{body:Buffer.concat(chunks).toString()}:{}),});
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
      }catch(error){console.warn("[claude-recovery-fixture] Request failed",error instanceof Error?error.name:typeof error);res.writeHead(503);res.end();}
      return;
    }
    const forward=request(upstream.url+(req.url??"/"),{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
    forward.on("error",()=>{res.writeHead(502);res.end();});req.pipe(forward);
  });
  server.on("upgrade",(req,socket,head)=>{
    const target=connect(Number(new URL(upstream.url).port),"127.0.0.1",()=>{
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key,value])=>`${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if(head.length)target.write(head);target.pipe(socket);socket.pipe(target);
    });
    target.on("error",()=>socket.destroy());socket.on("error",()=>target.destroy());socket.on("close",()=>target.destroy());
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,snapshot,
    counters:()=>({completions,browserStarts,terminalStarts}),setFailAdoption:(value:boolean)=>{failAdoption=value;},
    async close(){await service.close();server.closeAllConnections();await upstream.close();await new Promise<void>(resolve=>server.close(()=>resolve()));},
  };
}
