import {expect,it} from "vitest";
import {ProviderSettingsSnapshotSchema} from "@matrix-os/contracts";
import {createTerminalClaudeFixture} from "./fixtures/claude-terminal-auth.js";
import {nativeClaudeConnection} from "../../packages/ui/src/agents-providers/legacy-claude-connection.js";

it("synchronizes external Terminal login, principal replacement and logout through real native status/store/owner HTTP without a workflow",async()=>{
 const f=await createTerminalClaudeFixture();
 try{
  const read=async()=>{const response=await f.routes.request('/provider-settings?includeCapabilities=true&includeAccountDetails=true&includeClaudeAccountDetails=true');expect(response.status).toBe(200);return ProviderSettingsSnapshotSchema.parse(await response.json());};
  const signedOut=await read(),before=await f.configuration(),row=signedOut.harnesses.find(h=>h.id==='harness_kernel')!;
  expect(nativeClaudeConnection(row,signedOut.accounts,signedOut.accessSources)).toBeUndefined();
  await f.setStatus('first@example.test');const signedIn=await read(),connected=nativeClaudeConnection(signedIn.harnesses.find(h=>h.id===row.id)!,signedIn.accounts,signedIn.accessSources);
  expect(connected?.account.connectionDetails?.email).toBe('first@example.test');
  await f.setStatus('second@example.test');const changed=await read();expect(changed.accounts.find(a=>a.id==='owner_claude_profile')?.connectionDetails?.email).toBe('second@example.test');
  await f.setStatus(null);const loggedOut=await read();expect(nativeClaudeConnection(loggedOut.harnesses.find(h=>h.id===row.id)!,loggedOut.accounts,loggedOut.accessSources)).toBeUndefined();
  await f.setStatus('first@example.test',true);const unavailable=await read();expect(nativeClaudeConnection(unavailable.harnesses.find(h=>h.id===row.id)!,unavailable.accounts,unavailable.accessSources)).toBeUndefined();
  for(const snapshot of [signedIn,changed,loggedOut,unavailable]){
   expect(snapshot.revision).toBe(signedOut.revision);expect(snapshot.harnesses.find(h=>h.id===row.id)).toMatchObject({configuredEnabled:false,enabled:false,configuredAccessSourceId:'owner_anthropic_profile',selectedAccountId:'owner_anthropic',route:row.route});
  }
  expect(await f.configuration()).toBe(before);
 }finally{await f.close();}
});
it("discovers an earlier Terminal-only login on the first Settings owner read",async()=>{
 const f=await createTerminalClaudeFixture();try{
  await f.setStatus('already-signed-in@example.test');const before=await f.configuration();
  const response=await f.routes.request('/provider-settings?includeCapabilities=true&includeAccountDetails=true&includeClaudeAccountDetails=true');expect(response.status).toBe(200);
  const snapshot=ProviderSettingsSnapshotSchema.parse(await response.json());
  expect(nativeClaudeConnection(snapshot.harnesses.find(h=>h.id==='harness_kernel')!,snapshot.accounts,snapshot.accessSources)?.account.connectionDetails?.email).toBe('already-signed-in@example.test');
  expect(await f.configuration()).toBe(before);
 }finally{await f.close();}
});
