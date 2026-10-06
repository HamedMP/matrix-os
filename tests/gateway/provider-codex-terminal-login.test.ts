import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_TERMINAL_LOGIN_COMMAND, CODEX_TERMINAL_LOGIN_WORKER } from "../../packages/gateway/src/ai-providers/provider-codex-terminal-login.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function fixture(mode: "success" | "pending" | "mismatch" | "unsafe" | "malformed" | "wrong-version" | "duplicate-initialize" | "duplicate-device", canonicalCommand = false, expire = false) {
  const home = await mkdtemp(join(tmpdir(), "codex-terminal-login-"));
  const nativeAccount = join(home, "account"); const requests = join(home, "requests");
  await writeFile(nativeAccount, "original-account");
  const bin = join(home, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "node"));
  const command = join(bin, "codex");
  await writeFile(command, `#!${process.execPath}
const fs=require("node:fs"),readline=require("node:readline");
if(process.argv.includes("--version")){console.log("codex-cli ${mode === "wrong-version" ? "0.153.4" : "0.156.1"}");process.exit(0);}
console.error("sk-private-upstream-diagnostic");
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},r.method+"\\n");
if(r.method==="initialize"){send({id:r.id,result:{}});if(${JSON.stringify(mode)}==="duplicate-initialize")send({id:r.id,result:{}});}
if(r.method==="account/login/start"){
 if(${JSON.stringify(mode)}==="malformed")console.log("invalid-private-output");
 else send({id:r.id,result:{type:"chatgptDeviceCode",loginId:"native-attempt",verificationUrl:${JSON.stringify(mode === "unsafe" ? "https://evil.test/device" : "https://auth.openai.com/codex/device")},userCode:"ABCD-EFGHI"}});
 if(${JSON.stringify(mode)}==="duplicate-device")send({id:r.id,result:{type:"chatgptDeviceCode",loginId:"other-attempt",verificationUrl:"https://auth.openai.com/codex/device",userCode:"IJKL-MNOP"}});
 if(${JSON.stringify(mode)}==="success")setTimeout(()=>{fs.writeFileSync(${JSON.stringify(nativeAccount)},"new-native-account");send({method:"account/login/completed",params:{loginId:"native-attempt",success:true}})},25);
 if(${JSON.stringify(mode)}==="mismatch")setTimeout(()=>send({method:"account/login/completed",params:{loginId:"other-attempt",success:true}}),25);
}
if(r.method==="account/login/cancel")send({id:r.id,result:{status:"canceled"}});
});`);
  await chmod(command, 0o700);
  // Accelerate only the actual production lifetime timer. The worker source,
  // native protocol, cancellation grace and process drain stay unchanged.
  const worker = expire ? `const schedule=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>schedule(callback,ms===600000?500:ms,...args);await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(CODEX_TERMINAL_LOGIN_WORKER).toString("base64")}`)});` : CODEX_TERMINAL_LOGIN_WORKER;
  const child = spawn(canonicalCommand ? "sh" : process.execPath, canonicalCommand ? ["-c", CODEX_TERMINAL_LOGIN_COMMAND] : ["--input-type=module", "--eval", worker], {
    cwd: home, env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, MATRIX_NODE_PREFIX: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; await rm(home, { recursive: true, force: true }); });
  return { child, exited, output: () => output, errors: () => errors, account: () => readFile(nativeAccount, "utf8"), requests: () => readFile(requests, "utf8") };
}

it("shows bounded official device instructions and exits only after native completion drains", async () => {
  const f = await fixture("success");
  expect(await f.exited).toBe(0);
  expect(f.output()).toContain("https://auth.openai.com/codex/device");
  expect(f.output()).toContain("ABCD-EFGHI");
  expect(f.output()).toContain("Codex sign-in completed.");
  expect(await f.account()).toBe("new-native-account");
  expect(f.errors()).not.toContain("sk-private");
  expect(await f.requests()).not.toContain("account/logout");
});
it("runs the complete fixed canonical shell command without staging credentials or a missing bundle script", async () => {
  const f = await fixture("success", true);
  expect(await f.exited).toBe(0);
  expect(f.output()).toContain("Codex sign-in completed.");
  expect(await f.account()).toBe("new-native-account");
  expect(CODEX_TERMINAL_LOGIN_COMMAND).not.toContain("codex login --device-auth");
});

it.each(["pending", "mismatch"] as const)("cancels %s native consent and preserves the current account", async mode => {
  const f = await fixture(mode);
  await vi.waitFor(() => expect(f.output()).toContain("ABCD-EFGHI"), { timeout: 5000 });
  if (mode === "mismatch") await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.output()).not.toContain("Codex sign-in completed.");
  f.child.kill("SIGTERM");
  expect(await f.exited).toBe(1);
  expect(await f.account()).toBe("original-account");
  expect(await f.requests()).toContain("account/login/cancel");
  expect(await f.requests()).not.toContain("account/logout");
  expect(f.errors()).not.toContain("sk-private");
});
it("expires pending consent through native cancellation before closing the helper", async () => {
  const f = await fixture("pending", false, true);
  expect(await f.exited).toBe(1);
  expect(await f.account()).toBe("original-account");
  expect(await f.requests()).toContain("account/login/cancel");
  expect(f.output()).not.toContain("Codex sign-in completed.");
});
it.each(["duplicate-initialize", "duplicate-device"] as const)("rejects %s without starting multiple native logins or accepting a replaced attempt", async mode => {
  const f = await fixture(mode);
  const failed = f.exited;
  await vi.waitFor(() => expect(f.output()).toContain("Codex sign-in was not completed."), { timeout: 5000 });
  expect(await failed).toBe(1);
  expect(await f.account()).toBe("original-account");
  expect((await f.requests()).split("\n").filter(method => method === "account/login/start").length).toBeLessThanOrEqual(1);
  expect(f.output()).not.toContain("IJKL-MNOP");
});

it.each(["unsafe", "malformed", "wrong-version"] as const)("rejects %s runtime output without exposing native diagnostics or replacing credentials", async mode => {
  const f = await fixture(mode);
  expect(await f.exited).toBe(1);
  expect(await f.account()).toBe("original-account");
  expect(f.output()).not.toContain("ABCD-EFGHI");
  expect(f.output()).not.toContain("evil.test");
  expect(f.output()).not.toContain("invalid-private");
  expect(f.output()).not.toContain("Codex sign-in completed.");
  expect(f.errors()).not.toContain("sk-private");
});
