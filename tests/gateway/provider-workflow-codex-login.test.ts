import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCodexSettingsLogin } from "../../packages/gateway/src/ai-providers/provider-workflow-codex-login.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const homes: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(mode: string) {
  const home = await mkdtemp(join(tmpdir(), "codex-settings-login-")); homes.push(home);
  await writeFile(join(home, "existing-account"), "original-account");
  const script = join(home, "fake-server.cjs");
  await writeFile(script, `const readline=require('node:readline');const fs=require('node:fs');
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TEST_REQUESTS,r.method+'\\n');
if(r.method==='initialize')send({id:r.id,result:{}});
if(r.method==='account/login/start') {send({id:r.id,result:{type:'chatgptDeviceCode',loginId:'fixture-login',verificationUrl:${JSON.stringify(mode === "unsafe" ? "https://evil.test/codex/device" : "https://auth.openai.com/codex/device")},userCode:${JSON.stringify(mode === 'lowercase' ? 'abcd-efghi' : 'ABCD-EFGHI')}}});
if(${JSON.stringify(mode)}==='success')setTimeout(()=>{fs.writeFileSync(process.env.TEST_ACCOUNT,'connected-account');send({method:'account/login/completed',params:{loginId:'fixture-login',success:true}})},25);
if(${JSON.stringify(mode)}==='mismatch')setTimeout(()=>send({method:'account/login/completed',params:{loginId:'other-login',success:true}}),25);}
if(r.method==='account/login/cancel')send({id:r.id,result:{status:'canceled'}});
});`);
  const publish = vi.fn(), complete = vi.fn(), release = vi.fn();
  const start = createCodexSettingsLogin({ command: process.execPath, args: [script], cwd: home,
    env: { HOME: home, TEST_REQUESTS: join(home, "requests"), TEST_ACCOUNT: join(home, "existing-account") }, acquire: async () => release });
  const running = await start({ publish, onSuccess: complete });
  return { home, publish, complete, release, running };
}
it("shows the official device URL/code in Settings and commits only native completion", async () => {
  const f = await fixture("success");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ authorizationUrl: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGHI" }));
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }));
  expect(f.complete).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  expect(await readFile(join(f.home, "existing-account"), "utf8")).toBe("connected-account");
});
it("cancels through native account RPC without logging out or losing the existing account", async () => {
  const f = await fixture("pending");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ deviceCode: "ABCD-EFGHI" })));
  await f.running.cancel();
  expect(await readFile(join(f.home, "existing-account"), "utf8")).toBe("original-account");
  const requests = await readFile(join(f.home, "requests"), "utf8");
  expect(requests).toContain("account/login/cancel"); expect(requests).not.toContain("account/logout");
  expect(f.complete).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});
it("ignores another login's completion", async () => {
  const f = await fixture("mismatch");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ deviceCode: "ABCD-EFGHI" })));
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.complete).not.toHaveBeenCalled(); await f.running.cancel();
});
it("rejects an untrusted authorization URL without publishing it", async () => {
  const f = await fixture("unsafe");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: "failed", safeFailure: "unavailable" }));
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ authorizationUrl: expect.any(String) }));
  expect(f.complete).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});

it("rejects a device code outside the public workflow contract", async () => {
  const f = await fixture("lowercase");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: "failed", safeFailure: "unavailable" }));
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ deviceCode: expect.any(String) }));
  expect(f.release).toHaveBeenCalledOnce();
});
it("does not confirm cancellation or release the profile when the native child cannot be reaped", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false) });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
  const release = vi.fn(), publish = vi.fn(), onSuccess = vi.fn();
  const running = await createCodexSettingsLogin({ command: "fake-codex", cwd: "/fake", env: {}, acquire: async () => release })({ publish, onSuccess });
  const outcome = running.cancel().then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ message: "unavailable" });
  expect(release).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
  child.emit("close", 1);
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  await expect(running.cancel()).resolves.toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});
