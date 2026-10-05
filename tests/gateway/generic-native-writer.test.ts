import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, expect, it, vi} from "vitest";
import {createGenericNativeWriter, guardGenericNativeKeys} from "../../packages/gateway/src/ai-providers/generic-native-writer.js";
import {createProviderKeyVerifier} from "../../packages/gateway/src/ai-providers/provider-workflow-key.js";
import {ProviderWorkflowError} from "../../packages/gateway/src/ai-providers/provider-workflows.js";
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true})));});
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"generic-native-writer-")); roots.push(root);
 const home=join(root,"home"); await mkdir(home);
 return {home,writer:createGenericNativeWriter(home)};
}
it.each(["pi","opencode","hermes","openclaw"] as const)("keeps %s admission through native drain and route activation across restart",async profile => {
 const {home,writer}=await fixture(); let drain!:()=>void, activate!:()=>void;
 const drained=new Promise<void>(resolve=>{drain=resolve;});
 const activated=new Promise<void>(resolve=>{activate=resolve;});
 const native=vi.fn(async()=>{await drained; await activated; return "connected";});
 const running=writer.run(profile,native); await vi.waitFor(()=>expect(native).toHaveBeenCalledOnce());
 const competitor=vi.fn();
 await expect(createGenericNativeWriter(home).run(profile,competitor)).rejects.toThrow();
 drain(); await Promise.resolve();
 await expect(createGenericNativeWriter(home).run(profile,competitor)).rejects.toThrow();
 expect(competitor).not.toHaveBeenCalled();
 activate(); expect(await running).toBe("connected");
 await expect(createGenericNativeWriter(home).run(profile,async()=>"next")).resolves.toBe("next");
});
it("keeps an ambiguous writer failure fenced after gateway recreation",async()=>{
 const {home,writer}=await fixture();
 await expect(writer.run("pi",async()=>{throw new Error("uncertain native write");})).rejects.toThrow();
 const next=vi.fn(); await expect(createGenericNativeWriter(home).run("pi",next)).rejects.toThrow();
 expect(next).not.toHaveBeenCalled();
 await expect(writer.run("opencode",async()=>"independent")).resolves.toBe("independent");
});
it.each([401,500])("releases a typed pre-write probe refusal (%s) without a native write",async status=>{
 const {home,writer}=await fixture(), save=vi.fn();
 const verifier=createProviderKeyVerifier({providerId:"openai",save,fetchFn:async()=>new Response(null,{status})});
 await expect(writer.run("hermes",()=>verifier({harnessInstanceId:"hermes",providerId:"openai",apiKey:"synthetic"}))).rejects.toMatchObject({code:"rejected"});
 expect(save).not.toHaveBeenCalled();
 await expect(createGenericNativeWriter(home).run("hermes",async()=>"next")).resolves.toBe("next");
});
it("releases a timed-out pre-write probe but not a native error with the same outward code",async()=>{
 const {home,writer}=await fixture(), save=vi.fn();
 const verifier=createProviderKeyVerifier({providerId:"openai",save,fetchFn:async()=>{throw new DOMException("timeout","TimeoutError");}});
 await expect(writer.run("openclaw",()=>verifier({harnessInstanceId:"openclaw",providerId:"openai",apiKey:"synthetic"}))).rejects.toMatchObject({code:"unavailable"});
 expect(save).not.toHaveBeenCalled();
 await expect(createGenericNativeWriter(home).run("openclaw",async()=>"next")).resolves.toBe("next");
 await expect(writer.run("openclaw",async()=>{throw new ProviderWorkflowError("unavailable");})).rejects.toThrow();
 await expect(createGenericNativeWriter(home).run("openclaw",async()=>"unsafe retry")).rejects.toThrow();
});
it("preserves exact key and connection methods while fencing failed activation",async()=>{
 const {home,writer}=await fixture();
 const input={harnessInstanceId:"pi",providerId:"anthropic" as const,apiKey:"synthetic"};
 const connection={capabilities:vi.fn(),verifyKey:vi.fn(async()=>{throw new ProviderWorkflowError("unavailable");})};
 const guarded=guardGenericNativeKeys(writer,"pi",connection);
 expect(guarded.capabilities).toBe(connection.capabilities);
 await expect(guarded.verifyKey(input)).rejects.toThrow();
 expect(connection.verifyKey).toHaveBeenCalledWith(input);
 await expect(createGenericNativeWriter(home).run("pi",async()=>"unsafe retry")).rejects.toThrow();
});
it("rejects unknown and official profile identifiers without invoking a writer",async()=>{
 const {writer}=await fixture(), execute=vi.fn();
 for(const profile of ["codex","claude","../escape"]) await expect(writer.run(profile as never,execute)).rejects.toThrow();
 expect(execute).not.toHaveBeenCalled();
});
