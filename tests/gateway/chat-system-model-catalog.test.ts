import type { AgentProviderDescriptor } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { systemModels } from "../../packages/gateway/src/chat/system-model-catalog.js";

function provider(id:string, count:number): AgentProviderDescriptor {
  return { id, displayName:id, runtime:"hermes", scopes:["messaging"],authKind:"oauth_login",supportedAuthKinds:["oauth_login"],
    authStatus:{state:"ready",authenticated:true,action:"none"},models:Array.from({length:count},(_,i)=>({
      id:`model-${i}`,displayName:`Model ${i}`,available:true,capabilities:["tools"],efforts:[]})) };
}

describe("bounded system model catalog",()=>{
  it("keeps the authenticated Codex subscription represented after a large earlier provider",()=>{
    const models=systemModels("hermes",[provider("anthropic",13),provider("copilot",54),provider("openai-codex",10)]);
    expect(models).toHaveLength(64);
    expect(models.filter(m=>m.id.startsWith("openai-codex:"))).toHaveLength(10);
    expect(models.find(m=>m.id === "anthropic:model-0")).toBeDefined();
  });
  it("excludes unauthenticated providers while bounding the remaining runtime inventory",()=>{
    const unauthenticated=provider("openai-codex",10);
    unauthenticated.authStatus={state:"action_required",authenticated:false,action:"open_login_terminal"};
    expect(systemModels("hermes",[provider("copilot",70),unauthenticated])).toHaveLength(64);
    expect(systemModels("hermes",[provider("copilot",70),unauthenticated]).every(m=>m.id.startsWith("copilot:"))).toBe(true);
  });
});
