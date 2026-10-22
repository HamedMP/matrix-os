import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeNativeUsageReader, normalizeClaudeNativeUsage } from "../../packages/gateway/src/ai-providers/claude-native-usage.js";
const now = new Date("2026-10-07T15:00:00Z");
const raw = { five_hour: { utilization: 3, resets_at: "2026-10-07T20:10:00.152986+00:00" }, seven_day: { utilization: 14, resets_at: "2026-10-12T13:00:00Z" } };
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, {recursive:true,force:true}))); });
async function fixture(clock: () => Date = () => now) {
 const home = await mkdtemp(join(tmpdir(), "claude-usage-")); homes.push(home);
 await mkdir(join(home, ".claude"), {mode:0o700});
 const path = join(home, ".claude/.credentials.json");
 const credentials = {claudeAiOauth:{accessToken:"fixture-secret",expiresAt:+now+3600000,scopes:["user:profile","user:inference"]}};
 await writeFile(path, JSON.stringify(credentials), {mode:0o600});
 const fetcher = vi.fn(async () => new Response(JSON.stringify(raw)));
 const read = createClaudeNativeUsageReader({homePath:home, now:clock, fetch:fetcher});
 return {home,path,credentials,fetcher,read};
}
it("normalizes only real five-hour allowance and reset", () => {
 expect(normalizeClaudeNativeUsage(raw,now)).toEqual({kind:"subscription_allowance",authority:"provider_allowance",state:"current",scope:"account",usedBasisPoints:300,resetsAt:"2026-10-07T20:10:00.152Z",asOf:now.toISOString()});
 expect(normalizeClaudeNativeUsage({...raw,five_hour:null},now)).toBeUndefined();
 expect(normalizeClaudeNativeUsage({...raw,five_hour:{utilization:101,resets_at:raw.five_hour.resets_at}},now)).toBeUndefined();
 expect(normalizeClaudeNativeUsage({...raw,five_hour:{utilization:3,resets_at:now.toISOString()}},now)).toBeUndefined();
});
it("reads quota server-side, coalesces reads, and retains only normalized data", async () => {
 const f=await fixture(); const [a,b]=await Promise.all([f.read(),f.read()]);
 expect(a?.usage?.usedBasisPoints).toBe(300); expect(b).toEqual(a);
 expect(f.fetcher).toHaveBeenCalledOnce();
 expect(f.fetcher).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage",expect.objectContaining({redirect:"error",signal:expect.any(AbortSignal),headers:expect.objectContaining({Authorization:"Bearer fixture-secret"})}));
 expect(JSON.stringify(a)).not.toMatch(/fixture-secret|accessToken|seven_day/);
 expect(await a?.isCurrent()).toBe(true);
 await writeFile(f.path,JSON.stringify({...f.credentials,claudeAiOauth:{...f.credentials.claudeAiOauth,accessToken:"replacement"}}));
 expect(await a?.isCurrent()).toBe(false);
});
it.each([401,403,429,500])("quota %s preserves an unavailable result without exposing errors", async status=>{
 const f=await fixture(); f.fetcher.mockImplementation(async()=>new Response("private error",{status}));
 expect(await f.read()).toBeNull(); expect(await f.read()).toBeNull(); expect(f.fetcher).toHaveBeenCalledOnce();
});
it("rejects missing profile scope, expired credentials, and symlinks without fetching",async()=>{
 const f=await fixture();
 await writeFile(f.path,JSON.stringify({claudeAiOauth:{...f.credentials.claudeAiOauth,scopes:["user:inference"]}})); expect(await f.read()).toBeNull();
 await writeFile(f.path,JSON.stringify({claudeAiOauth:{...f.credentials.claudeAiOauth,expiresAt:+now}})); expect(await f.read()).toBeNull();
 await rm(f.path); await symlink("/dev/null",f.path); expect(await f.read()).toBeNull(); expect(f.fetcher).not.toHaveBeenCalled();
});
it("rejects a credential change while usage is in flight",async()=>{
 const f=await fixture(); f.fetcher.mockImplementation(async()=>{await writeFile(f.path,JSON.stringify({...f.credentials,claudeAiOauth:{...f.credentials.claudeAiOauth,accessToken:"replacement"}}));return new Response(JSON.stringify(raw));});
 expect(await f.read()).toBeNull();
});
it("caps upstream payloads",async()=>{
 const f=await fixture(); f.fetcher.mockImplementation(async()=>new Response(" ".repeat(65537)));
 expect(await f.read()).toBeNull();
});

it("refetches a reset allowance window before the positive cache TTL elapses", async () => {
 let time = now;
 const f = await fixture(() => time);
 const reset = new Date(+now + 60_000).toISOString();
 f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({five_hour:{utilization:100,resets_at:reset}})))
   .mockResolvedValueOnce(new Response(JSON.stringify({five_hour:{utilization:0,resets_at:new Date(+now+3600000).toISOString()}})));
 const before = await f.read();
 expect(before?.usage.usedBasisPoints).toBe(10000);
 time = new Date(reset);
 expect(await before?.isCurrent()).toBe(false);
 const after = await f.read();
 expect(after?.usage.usedBasisPoints).toBe(0);
 expect(after?.usage.asOf).toBe(time.toISOString());
 expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("retains the bounded negative cache and retries after its TTL", async () => {
 let time = now;
 const f = await fixture(() => time);
 f.fetcher.mockResolvedValueOnce(new Response("unavailable",{status:429}));
 expect(await f.read()).toBeNull();
 time = new Date(+now+59_999);
 expect(await f.read()).toBeNull();
 expect(f.fetcher).toHaveBeenCalledOnce();
 time = new Date(+now+60_000);
 expect((await f.read())?.usage.usedBasisPoints).toBe(300);
 expect(f.fetcher).toHaveBeenCalledTimes(2);
});
