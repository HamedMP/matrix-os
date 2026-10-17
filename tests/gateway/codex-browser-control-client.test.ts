import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
it.each([false,true])("releases inference only after an acknowledged bind (lost acknowledgement=%s)",async(lost)=>{
 const home=await mkdtemp('/tmp/mx-browser-control-');const socket=codexProviderEventPath(home,'sess_browser_control').replace(/\.jsonl$/,'.sock');await mkdir(dirname(socket),{recursive:true});
 const frames:Record<string,unknown>[]=[];const server=createServer(peer=>{let text='';peer.setEncoding('utf8');peer.on('data',chunk=>{text+=chunk;if(!text.endsWith('\n'))return;frames.push(JSON.parse(text));if(lost)peer.destroy();else peer.end('{"ok":true}\n');});});
 await new Promise<void>(r=>server.listen(socket,r));
 try{const control=createCodexControlClient({homePath:home});const nonce=randomUUID();const operation=control.prepareBrowser!({sessionId:'sess_browser_control',browser:{attemptId:nonce,token:'a'.repeat(43),gatewayPort:4000},signal:AbortSignal.timeout(1000)});
 if(lost){await expect(operation).rejects.toMatchObject({name:'CodexControlTransportError'});expect(frames).toHaveLength(1);}
 else{await operation;expect(frames.map(x=>x.type)).toEqual(['browser_bind','browser_start']);expect(frames[1]).not.toHaveProperty('token');expect(frames[1].attemptId).toBe(nonce);}
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(home,{recursive:true,force:true});}
});
