import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createCodexNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata";
import { verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding";

// Only app-server I/O, the clock and private file-proof I/O are synthetic.
function fixture(holdFirst: boolean | number = false, closeOnKill = true) {
  const epoch = Date.parse("2026-10-17T10:00:00Z"); let elapsed = 0;
  let signedIn = false, proof: string | null = null, active = 0, maxActive = 0;
  const methods: string[] = [], children: EventEmitter[] = [];
  let releaseFirst: (() => void) | undefined;
  const spawnProcess = vi.fn(() => {
    const observedAccount = signedIn ? { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" } : null;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => {
      if (closeOnKill) queueMicrotask(() => { active--; child.emit("close", 0); }); return true;
    }) });
    active++; maxActive = Math.max(maxActive, active); children.push(child);
    child.stdin.on("data", chunk => {
      const req = JSON.parse(chunk.toString()); methods.push(req.method); if (!req.id) return;
      const result = req.method === "initialize" ? {} : req.method === "config/read" ? { config: { cli_auth_credentials_store: "file" } }
        : req.method === "account/rateLimits/read" ? { rateLimits: null, rateLimitsByLimitId: null } : { account: observedAccount, requiresOpenaiAuth: true };
      const send = () => child.stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
      if (holdFirst && children.length === (typeof holdFirst === "number" ? holdFirst : 1) && req.method === "initialize") releaseFirst = send;
      else queueMicrotask(send);
    });
    return child as never;
  });
  const reader = createCodexNativeAccountMetadataReader({ executable: "/synthetic/codex", cwd: "/synthetic/home", environment: { HOME: "/synthetic/home" },
    now: () => new Date(epoch + elapsed), spawnProcess, readCredentialFileProof: async () => proof, timeoutMs: 20, terminateGraceMs: 1 });
  return { reader, methods, children, spawnProcess, signIn: () => { signedIn = true; proof = "synthetic-new-generation"; }, rotate: () => { proof = "synthetic-rotated-generation"; }, advance: (ms: number) => { elapsed = ms; },
    maxActive: () => maxActive, release: () => releaseFirst?.(), ready: () => releaseFirst !== undefined };
}

it("admits a fresh private completion at 100ms after a signed-out read without waiting for quota cooldown", async () => {
  const f = fixture();
  expect(await f.reader()).toBeNull();
  f.signIn(); f.advance(100);
  expect(await f.reader()).toBeNull(); // Ordinary reads keep the five-second gate.
  expect(f.spawnProcess).toHaveBeenCalledOnce();
  const current = await f.reader({ purpose: "native_completion" });
  expect(current).toMatchObject({ authMethod: "terminal" });
  expect(await verifyNativeAccountMetadata(current)).toBe(current);
  expect(f.methods).not.toContain("account/rateLimits/read");
  expect(f.maxActive()).toBe(1);
  expect(await f.reader()).toBe(current);
});

it("keeps ordinary signed-out reads throttled until the controlled clock reaches five seconds", async () => {
  const f = fixture(); expect(await f.reader()).toBeNull(); f.signIn();
  f.advance(4999); expect(await f.reader()).toBeNull(); expect(f.spawnProcess).toHaveBeenCalledOnce();
  f.advance(5000); expect(await f.reader()).toMatchObject({ authMethod: "terminal" });
  expect(f.methods.filter(method => method === "account/rateLimits/read")).toHaveLength(1);
});
it("waits for the pending ordinary child to close before the private identity read", async () => {
  const f = fixture(true); const ordinary = f.reader();
  for (let tick=0; tick<10 && !f.ready(); tick++) await Promise.resolve();
  expect(f.ready()).toBe(true); f.signIn(); f.advance(100);
  const current = f.reader({ purpose: "native_completion" });
  await Promise.resolve(); expect(f.spawnProcess).toHaveBeenCalledOnce();
  f.release(); expect(await ordinary).toBeNull();
  expect(await current).toMatchObject({ authMethod: "terminal" }); expect(f.maxActive()).toBe(1);
});
it("coalesces concurrent private identity reads without querying allowance", async () => {
  const f=fixture(); f.signIn();
  const [a,b]=await Promise.all([f.reader({purpose:"native_completion"}),f.reader({purpose:"native_completion"})]);
  expect(a).not.toBeNull(); expect(a).toBe(b); expect(f.spawnProcess).toHaveBeenCalledOnce();
  expect(f.methods).not.toContain("account/rateLimits/read"); expect(f.maxActive()).toBe(1);
});
it("retains an unconfirmed-child-exit fence for private completion", async () => {
  const f=fixture(false,false);
  try {
    expect(await f.reader()).toBeNull(); f.signIn(); f.advance(100);
    expect(await f.reader({purpose:"native_completion"})).toBeNull(); expect(f.spawnProcess).toHaveBeenCalledOnce();
  } finally { for(const child of f.children) child.emit("close",0); }
});
it("rejects the old generation while returning a fresh privately verified completion identity", async () => {
  const f=fixture(); f.signIn(); const old=await f.reader(); expect(old).not.toBeNull();
  f.rotate(); f.advance(100);
  const current=await f.reader({purpose:"native_completion"}); expect(current).not.toBeNull();
  expect(await verifyNativeAccountMetadata(old)).toBeNull();
  expect(await verifyNativeAccountMetadata(current)).toBe(current);
  expect(f.methods.filter(method=>method==="account/rateLimits/read")).toHaveLength(1);
  expect(f.maxActive()).toBe(1);
});

it("does not borrow a pre-completion identity verification that observed an old generation", async () => {
  const f=fixture(2); f.signIn(); const old=await f.reader(); expect(old).not.toBeNull();
  const oldVerification=verifyNativeAccountMetadata(old);
  for(let tick=0;tick<20&&!f.ready();tick++) await Promise.resolve();
  expect(f.ready()).toBe(true); f.rotate(); f.advance(100);
  const completion=f.reader({purpose:"native_completion"});
  await Promise.resolve(); expect(f.spawnProcess).toHaveBeenCalledTimes(2);
  f.release(); expect(await oldVerification).toBeNull();
  expect(await completion).toMatchObject({authMethod:"terminal"});
  expect(f.spawnProcess).toHaveBeenCalledTimes(3); expect(f.maxActive()).toBe(1);
});
