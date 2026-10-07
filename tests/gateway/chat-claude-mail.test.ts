import {EventEmitter} from 'node:events';import {expect,it,vi} from 'vitest';
import {createClaudeChatProviderAdapter} from '../../packages/gateway/src/chat/claude-provider-adapter.js';
import {createMatrixMcpCapabilityRegistry} from '../../packages/gateway/src/chat/matrix-mcp-launch.js';
import type {CanonicalCliSpawn} from '../../packages/gateway/src/chat/cli-process.js';
const owner={type:'personal' as const,ownerId:'owner_claude'};
const input={owner,chatId:'chat_one',turnId:'cturn_one',runId:'run_one',prompt:'Read retained letters',parts:[{type:'text' as const,text:'Read retained letters'}],selection:{instanceId:'claude_code_default',model:'claude-sonnet-4-5'},interactionMode:'review',permissionMode:'full_access',executionRoot:'/safe/project',signal:new AbortController().signal};
it('launches a separate read-only mail server in native review and revokes both bearers',async()=>{
 const registry=createMatrixMcpCapabilityRegistry({configuredOwnerId:owner.ownerId});let mailToken:string|undefined;let customToken:string|undefined;let observed:{args:string[];mailActor:string|null;customMailActor:string|null}|undefined;
 const spawn=vi.fn<CanonicalCliSpawn>((_cmd,args,options)=>{
  mailToken=options.env.MATRIX_AGENT_MAIL_TOKEN;customToken=options.env.MATRIX_AGENT_INTEGRATIONS_TOKEN;
  observed={args,mailActor:mailToken?registry.resolve(mailToken,'POST','/api/mail/read'):null,customMailActor:customToken?registry.resolve(customToken,'POST','/api/mail/read'):null};
  const child=new EventEmitter() as EventEmitter&{stdout:EventEmitter;stderr:EventEmitter;stdin:{write(chunk:string,cb?:(error?:Error|null)=>void):boolean;end():void};kill:ReturnType<typeof vi.fn>};child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={write(_chunk,cb){cb?.();return true;},end(){}};child.kill=vi.fn();
  queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',subtype:'success',result:'read',session_id:'session_mail'})+'\n'));child.emit('exit',0,null);});return child;
 });
 const adapter=createClaudeChatProviderAdapter({homePath:'/home/matrix/home',spawnFn:spawn,resolveCredentialEnv:async()=>({}),matrixMcpCapabilityIssuer:registry});
 try{
  const events=[];for await(const event of adapter.start(input))events.push(event);expect(events.at(-1)).toMatchObject({type:'run.completed',outcome:'completed'});
  expect(spawn).toHaveBeenCalledOnce();expect(mailToken).toMatch(/^[a-f0-9]{64}$/);expect(customToken).not.toBe(mailToken);expect(observed?.mailActor).toBe(owner.ownerId);expect(observed?.customMailActor).toBeNull();
  const args=observed!.args;const config=JSON.parse(args[args.indexOf('--mcp-config')+1]!);expect(config.mcpServers['matrix-mail'].args).toEqual(['--require-scoped-capability','--tool-surface=mail-read']);expect(JSON.stringify(config)).not.toContain(mailToken);
  expect(JSON.parse(args[args.indexOf('--settings')+1]!).permissions.allow).toContain('mcp__matrix-mail__read_mail_archive');
  expect(registry.resolve(mailToken!,'POST','/api/mail/read')).toBeNull();expect(registry.resolve(customToken!,'GET','/api/mcp-servers')).toBeNull();
 }finally{registry.close();}
});
