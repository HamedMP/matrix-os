import {describe,it,expect} from 'vitest';
import {CanonicalProviderCatalogSchema} from '@matrix-os/contracts';
import {canonicalVoiceDecision} from '../../../packages/gateway/src/voice-session/canonical-ports.js';
import {nativeCompanionCanonicalDecision} from '../../../packages/gateway/src/live-companion/canonical-decision.js';
const selection={instanceId:'opencode_default',model:'@cf/zai-org/glm-5.3-flash'};
const catalog=CanonicalProviderCatalogSchema.parse({revision:'test',drivers:[{kind:'opencode',displayName:'OpenCode',adapterVersion:'1.0.0',capabilityClass:'coding_agent'}],instances:[{id:selection.instanceId,driverKind:'opencode',displayName:'OpenCode',workspaceRequirement:'project_optional',catalogRevision:'test',availability:'available',models:[{id:selection.model,displayName:'GLM',availability:'available',capabilities:['tools'],supportsVision:false,supportsToolUse:true}],options:[],skills:[],commands:[],setupActions:[],supports:{rootChat:true,resume:true,cancellation:'run',attachments:[],tools:['terminal'],approvals:true,userInput:true,worktrees:'none',resources:[],interactionModes:['default'],permissionModes:['full_access','supervised']},defaultSelection:selection}]});
describe('native companion canonical route',()=>{
 it('uses a runnable task harness without granting execution to native media',()=>{
  expect(canonicalVoiceDecision({selection,catalog})?.capability.status).toBe('unavailable');
  const decision=nativeCompanionCanonicalDecision({selection,catalog,surface:'electron_desktop'});
  expect(decision?.capability).toMatchObject({status:'available',surface:'electron_desktop',actionMode:'conversation_only',actionCancellation:'none'});
  expect(decision?.executionPolicy).toMatchObject({tools:[],delegation:false,actionMode:'conversation_only',workspaceScope:'apps'});
 expect(decision?.selection).toEqual(selection);
 });
 it('accepts the real supervised-only OpenCode route without requesting full access',()=>{
  const supervised=CanonicalProviderCatalogSchema.parse({...catalog,instances:[{...catalog.instances[0],supports:{...catalog.instances[0]!.supports,permissionModes:['supervised']}}]});
  const decision=nativeCompanionCanonicalDecision({selection,catalog:supervised});
  expect(decision?.capability.status).toBe('available');
  expect(decision?.permissionMode).toBe('supervised');
  expect(decision?.executionPolicy).toMatchObject({tools:[],delegation:false});
 });
 it('keeps native interruption and reconnect independent of task harness controls',()=>{
  const noRunControls=CanonicalProviderCatalogSchema.parse({...catalog,instances:[{...catalog.instances[0],supports:{...catalog.instances[0]!.supports,cancellation:'none',resume:false}}]});
  const decision=nativeCompanionCanonicalDecision({selection,catalog:noRunControls});
  expect(decision?.capability).toMatchObject({status:'available',supportsInterruption:true,resume:'rebuild_only',turnModes:['hands_free']});
  expect(decision?.executionPolicy).toMatchObject({tools:[],delegation:false});
 });
 it('fails closed for absent, unavailable, and mode-incompatible canonical routes',()=>{
  expect(nativeCompanionCanonicalDecision({selection:undefined,catalog})).toBeUndefined();
  for(const change of [{availability:'unavailable',defaultSelection:undefined}, {models:[],defaultSelection:undefined}, {supports:{...catalog.instances[0]!.supports,permissionModes:['full_access']}}]) {
   const bad=CanonicalProviderCatalogSchema.parse({...catalog,instances:[{...catalog.instances[0],...change}]});
   expect(nativeCompanionCanonicalDecision({selection,catalog:bad})?.capability.status).toBe('unavailable');
  }
 });
});
