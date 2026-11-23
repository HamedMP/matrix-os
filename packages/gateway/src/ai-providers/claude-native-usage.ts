import { createClaudeNativeCredentialReader } from "./claude-native-credential.js";
import { z } from "zod/v4";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

type Usage = NonNullable<CodexNativeAccountMetadata["usage"]>;
const WindowSchema = z.object({ five_hour: z.object({
  utilization: z.number().finite().min(0).max(100), resets_at: z.iso.datetime({offset:true}).nullable(),
}) });
export function normalizeClaudeNativeUsage(raw: unknown, now: Date): Usage | undefined {
  const parsed = WindowSchema.safeParse(raw);
  if (!parsed.success) return;
  const reset = parsed.data.five_hour.resets_at;
  if (reset !== null && Date.parse(reset) <= +now) return;
  return {kind:"subscription_allowance", authority:"provider_allowance", state:"current", scope:"account",
    usedBasisPoints:Math.round(parsed.data.five_hour.utilization * 100),
    resetsAt:reset === null ? null : new Date(reset).toISOString(), asOf:now.toISOString()};
}

/** Read-only native Linux credential authority. Tokens never enter snapshots or logs. */
export function createClaudeNativeUsageReader(input: {homePath:string; now?:()=>Date; fetch?:typeof fetch}) {
  const now = input.now ?? (() => new Date());
  const credential = createClaudeNativeCredentialReader({ ...input, scope: "user:profile", now });
  type Observation = {usage:Usage; isCurrent:()=>Promise<boolean>};
  let pending:Promise<Observation|null>|null=null;
  let cached:{proof:string; until:number; observation:Observation|null}|null=null;
  const fresh = (usage:Usage) => !usage.resetsAt || Date.parse(usage.resetsAt) > +now();
  return ():Promise<Observation|null> => {
    if (!pending) pending=(async()=>{
      const before = await credential();
      if (!before) {cached=null;return null;}
      if (cached?.proof === before.proof && cached.until > +now()) {
        // A failed probe keeps its short cooldown. A successful window that
        // reset during the longer TTL must fetch the next authoritative window.
        if (!cached.observation || fresh(cached.observation.usage)) return cached.observation;
      }
      cached={proof:before.proof,until:+now()+60_000,observation:null};
      try {
        const response=await (input.fetch ?? fetch)("https://api.anthropic.com/api/oauth/usage",{
          headers:{Authorization:`Bearer ${before.token}`,"anthropic-beta":"oauth-2025-04-20"},
          signal:AbortSignal.timeout(5000),redirect:"error",
        });
        if (!response.ok || !response.body) {await response.body?.cancel();return null;}
        const reader=response.body.getReader(); const chunks:Uint8Array[]=[];let size=0;
        try {
          for (;;) {
            const part=await reader.read();if (part.done) break;
            size+=part.value.byteLength;if(size>65_536){await reader.cancel();return null;}chunks.push(part.value);
          }
        } finally {reader.releaseLock();}
        const usage=normalizeClaudeNativeUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")),now());
        const proof=before.proof;
        if(!usage || (await credential())?.proof !== proof)return null;
        const observation={usage,isCurrent:async()=>fresh(usage) && (await credential())?.proof === proof};
        cached={proof,until:+now()+300_000,observation};return observation;
      } catch(error:unknown) {
        console.warn("[provider-settings] Claude usage unavailable:",error instanceof Error ? error.name : "UnknownError");
        return null;
      }
    })().finally(()=>{pending=null;});
    return pending;
  };
}
