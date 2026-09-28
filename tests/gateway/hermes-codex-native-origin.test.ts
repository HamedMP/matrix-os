import { describe,expect,it } from "vitest";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { projectHermesNativeCatalog } from "../../packages/gateway/src/ai-providers/hermes-native-catalog.js";

describe("Hermes built-in Codex subscription metadata",()=>{
  const now=new Date("2026-09-29T00:00:00Z");
  const native=(overrides:Record<string,unknown>={})=>normalizeHermesRuntimeSnapshot({observedAt:+now,status:{gateway_running:true},
    options:{provider:"openai-codex",model:"gpt-6-astra",providers:[{slug:"openai-codex",name:"ChatGPT or Codex Subscription",
      authenticated:true,is_user_defined:false,models:["gpt-6-astra","gpt-5.6-sol"],...overrides}]}});

  it("recognizes the built-in OAuth-only source when the native endpoint omits legacy auth_type",()=>{
    const snapshot=native();
    expect(snapshot.runtime.options[0]?.nativeRouteObservation?.credentialKind).toBe("provider_profile");
    expect(projectHermesNativeCatalog(snapshot,now).profiles[0]).toMatchObject({harness:"hermes",providerId:"openai-codex",
      localObservation:{state:"present_unverified"},defaultModelId:"openai-codex:gpt-6-astra"});
  });
  it.each([{is_user_defined:true},{is_user_defined:undefined},{auth_type:"api_key"},{auth_type:"unrecognized"}])(
    "does not infer subscription origin from ambiguous or overridden records %j",overrides=>{
      expect(projectHermesNativeCatalog(native(overrides),now).profiles).toEqual([]);
    });
});
