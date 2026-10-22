import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

type Usage = NonNullable<CodexNativeAccountMetadata["usage"]>;
const CredentialSchema = z.object({ claudeAiOauth: z.object({
  accessToken: z.string().min(1).max(16_384), expiresAt: z.number().finite(),
  scopes: z.array(z.string().max(120)).max(32),
}) });
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
  const home = resolve(input.homePath);
  const key = randomBytes(32);
  const now = input.now ?? (()=>new Date());
  const credential = async () => {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) return null;
      const canonical = await realpath(home);
      for (const start of [home, canonical]) for (let parent=start;;parent=dirname(parent)) {
        const info = await lstat(parent);
        const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if ((!info.isDirectory() && !info.isSymbolicLink()) || ![0,uid].includes(info.uid)
          || !info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !stickyRoot
          || parent === start && (info.uid !== uid || info.isSymbolicLink())) return null;
        if (dirname(parent) === parent) break;
      }
      const directory = join(canonical,".claude");
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) return null;
      const path = join(directory,".credentials.json");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o077) !== 0) return null;
      const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(65_537);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size < 2 || info.size > 65_536
          || info.ino !== before.ino || info.dev !== before.dev) return null;
        const {bytesRead} = await file.read(bytes,0,bytes.length,0);
        if (bytesRead !== info.size || bytesRead > 65_536) return null;
        const parsed = CredentialSchema.safeParse(JSON.parse(bytes.subarray(0,bytesRead).toString("utf8")));
        if (!parsed.success || parsed.data.claudeAiOauth.expiresAt <= +now()
          || !parsed.data.claudeAiOauth.scopes.includes("user:profile")) return null;
        const after = await file.stat(); const current = await lstat(path); const currentDir = await lstat(directory);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
          || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()
          || currentDir.ino !== dir.ino || currentDir.dev !== dir.dev || currentDir.isSymbolicLink()
          || await realpath(home) !== canonical) return null;
        return {token:parsed.data.claudeAiOauth.accessToken,
          proof:createHmac("sha256",key).update(canonical).update(bytes.subarray(0,bytesRead)).digest("hex")};
      } finally { bytes.fill(0); await file.close(); }
    } catch(error:unknown) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException)?.code !== "ENOENT")
        console.warn("[provider-settings] Claude usage credential unavailable:",error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
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
