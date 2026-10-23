import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { createOpenClawRpcClient } from '../../packages/gateway/src/agent-config/openclaw-rpc.js';
import { createSharedBrowserBroker } from '../../packages/gateway/src/shared-browser/broker.js';
import { openOpenClawSharedBrowserRun } from '../../packages/gateway/src/chat/openclaw-shared-browser-run.js';
import { registerOpenClawSharedBrowserPlugin } from '../../packages/gateway/src/chat/openclaw-shared-browser-plugin.js';

it('projects only wire lease fields through real RPC validation and the native plugin', async () => {
  const broker = createSharedBrowserBroker({ ownerId:'owner_qa', setHumanControl:async()=>{},
    driver:{execute:async()=>({success:true}),invalidateObservation(){},detach:async()=>{}} });
  const methods = new Map<string, (event:{params:unknown;respond(ok:boolean,value?:unknown,error?:unknown):void})=>Promise<void>>();
  const stopPlugin = registerOpenClawSharedBrowserPlugin({registerGatewayMethod(name,handler){methods.set(name,handler);},registerTool(){},on(){}}, {
    gatewayPort:4000,fetcher:async(_url,init)=>{
      const token=new Headers(init?.headers).get('authorization')!.slice(7);
      const binding=broker.resolveCapability(token);
      if (!binding) return new Response(null, { status: 401 });
      return Response.json(await broker.execute(binding,JSON.parse(init!.body as string),init!.signal!));
    },
  });
  class Socket extends EventEmitter {
    readyState=1;
    readonly sent:Array<{id:string;method:string;params:Record<string,unknown>}>=[];
    constructor(){super();queueMicrotask(()=>this.receive({type:'event',event:'connect.challenge',payload:{nonce:'fixture',ts:1}}));}
    receive(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)));}
    send(data:string){
      const frame=JSON.parse(data);if(this.sent.length>=16)throw Error('Fixture frame cap');this.sent.push(frame);
      if(frame.method==='connect'){queueMicrotask(()=>this.receive({type:'res',id:frame.id,ok:true,payload:{
        type:'hello-ok',protocol:4,server:{version:'2026.7.1',connId:'fixture'},
        features:{methods:['matrix.browser.bind','matrix.browser.revoke'],events:[]},snapshot:{},
        auth:{role:'operator',scopes:['operator.read','operator.write','operator.admin']},
        policy:{maxPayload:1048576,maxBufferedBytes:2097152,tickIntervalMs:15000},
      }}));return;}
      const handler=methods.get(frame.method);if(!handler)throw Error('Unexpected fixture method');
      void handler({params:frame.params,respond:(ok,payload,error)=>this.receive({type:'res',id:frame.id,ok,...(ok?{payload}:{error})})});
    }
    close(){this.readyState=3;this.emit('close');}
  }
  let socket:Socket|undefined;
  const rpc=createOpenClawRpcClient({url:'ws://127.0.0.1:18789',token:'a'.repeat(64),socketFactory:()=>socket=new Socket()});
  // Model the enumerable run cleanup added by native harnesses using a real broker lease.
  const futureBroker={...broker,openRun(binding:Parameters<typeof broker.openRun>[0],signal:AbortSignal){
    return Object.assign(broker.openRun(binding,signal),{close:()=>broker.closeRun(binding.runId)});
  }};
  try{
    const handle=await openOpenClawSharedBrowserRun({broker:futureBroker,rpc,ownerId:'owner_qa',chatId:'chat_qa',runId:'run_qa',sessionKey:'fixture',signal:new AbortController().signal});
    const bind=socket!.sent.find(frame=>frame.method==='matrix.browser.bind')!;
    expect(Object.keys(bind.params).sort()).toEqual(['bindingId','expiresAt','runId','sessionKey','token']);
    await handle.close();
    expect(broker.status()).toMatchObject({phase:'idle'});
    expect(broker.resolveCapability(bind.params.token as string)).toBeNull();
  }finally{await rpc.close();stopPlugin();await broker.close();}
});
