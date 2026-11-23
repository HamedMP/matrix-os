import { nativeCodexConfigurationFingerprint } from "../../packages/gateway/src/coding-agents/native-codex-configuration-fingerprint.mjs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { codexNativeGenerationSource, createCodexCredentialFileEvidenceReader } from "../../packages/gateway/src/ai-providers/codex-credential-file-proof.js";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(account: unknown, modelProvider: string, resume = false, options: { unexpectedOutputClose?: boolean; file?: boolean; replaceAfterThread?: boolean; credentialAccountId?: string; refreshAfterThread?: string; legacyConsent?: "aliased" | "unaliased" | "other-account"; nextAccount?: unknown; configuredProvider?: string; revokeAt?: "before-spawn" | "after-thread"; revokeKind?: "off" | "reconnected" | "uncertain" | "route" | "model" | "presentation"; threadDeleteFails?: boolean } = {}) {
  const dir = await mkdtemp("/tmp/codex-native-runner-"); dirs.push(dir);
  const trace = join(dir, "trace.jsonl");
  const accountTokens = (access: string, accountId?: string) => ({ access_token: access, refresh_token: `${access}-refresh`, ...(accountId ? { account_id: accountId } : {}) });
  if (options.file) { await mkdir(join(dir, ".codex"), { mode: 0o700 }); await writeFile(join(dir, ".codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: accountTokens("fixture-access", options.credentialAccountId) }), { mode: 0o600 }); }
  const evidence = options.file ? await createCodexCredentialFileEvidenceReader({ homePath: dir })() : null;
  const durablePrincipalFingerprint = createHash("sha256").update(codexNativeGenerationSource({ principal: { type: "chatgpt", email: "owner@example.test", id: "account-a" },
    credentialProof: evidence?.proof ?? null, credentialIdentity: evidence?.identity ?? null })).digest("hex");
  // Consent saved before durable generations named the exact token bytes.
  const expectedPrincipalFingerprint = options.legacyConsent
    ? createHash("sha256").update(JSON.stringify({ principal: { type: "chatgpt", email: "owner@example.test", id: "account-a" }, credentialProof: "pre-upgrade-bytes" })).digest("hex")
    : durablePrincipalFingerprint;
  const settingsPath = join(dir, "system/ai-providers/settings.json");
  const markerPath = join(dir, "system/ai-providers/codex-execution-revocation.json");
  const row = { id: "codex_owner_openai_profile", harness: "codex", enabled: true,
    accessSourceId: "owner_openai_profile", selectedAccountId: "owner_codex",
    nativeAccountGeneration: expectedPrincipalFingerprint, nativeAccountConsentRevision: 1,
    route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } };
  const changedRow = { ...row, ...(options.revokeKind === "route" ? { route: { ...row.route, providerId: "funded" } }
    : options.revokeKind === "model" ? { route: { ...row.route, modelId: "openai/another-model" } }
    : options.revokeKind === "presentation" ? { displayName: "Renamed Codex", accentColor: "blue" }
    : options.revokeKind === "reconnected" ? { nativeAccountConsentRevision: 2 } : { enabled: false }) };
  await mkdir(join(dir, "system/ai-providers"), { recursive: true });
  if (options.legacyConsent === "aliased" || options.legacyConsent === "other-account") await writeFile(join(dir, "system/ai-providers/codex-consent-alias.json"), JSON.stringify({ version: 1,
    saved: expectedPrincipalFingerprint, durable: options.legacyConsent === "aliased" ? durablePrincipalFingerprint : createHash("sha256").update("other-account").digest("hex") }));
  await writeFile(settingsPath, JSON.stringify({ harnesses: [row] }));
  const revokeScript = options.revokeKind === "uncertain"
    ? `writeFileSync(${JSON.stringify(markerPath)}, '{}');`
    // Atomic replace, like provider-settings-persistence: the account proof now
    // reads settings concurrently with thread/start and must never see a torn file.
    : `writeFileSync(${JSON.stringify(settingsPath + ".tmp")}, ${JSON.stringify(JSON.stringify({ harnesses: [changedRow] }))}); renameSync(${JSON.stringify(settingsPath + ".tmp")}, ${JSON.stringify(settingsPath)});`;
  if (options.revokeAt === "before-spawn") {
    // Completed revocation has no marker; only durable saved intent fences a delayed child.
    if (options.revokeKind === "uncertain") await writeFile(markerPath, '{}');
    else await writeFile(settingsPath, JSON.stringify({ harnesses: [changedRow] }));
  }
  const executable = join(dir, "fake-codex");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value)+'\\n');
if (process.argv.includes("--version")) { console.log("codex ${CODEX_VERIFIED_VERSION}"); process.exit(0); }
record({ env: {HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,OPENAI_API_KEY:process.env.OPENAI_API_KEY}, args: process.argv.slice(2) });
process.once('SIGTERM', () => { record({ shutdown: 'SIGTERM' }); process.exit(0); });
let accountReads = 0;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); record(m);
 const send = result => console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='initialize') send({});
 else if(m.method==='config/read') send({config:{model_provider:${JSON.stringify(options.configuredProvider ?? "openai")},openai_base_url:"",chatgpt_base_url:"https://chatgpt.com/backend-api/",cli_auth_credentials_store:${JSON.stringify(options.file ? "file" : "keyring")}}});
 else if(m.method==='account/read') send({account:++accountReads > 1 ? ${JSON.stringify(options.nextAccount ?? account)} : ${JSON.stringify(account)}});
 else if(m.method==='thread/start'||m.method==='thread/resume') { ${options.revokeAt === 'after-thread' ? revokeScript : ''} if (${JSON.stringify(options.refreshAfterThread ?? "")}) writeFileSync(${JSON.stringify(join(dir, '.codex/auth.json'))}, JSON.stringify({auth_mode:'chatgpt',last_refresh:'later',tokens:${JSON.stringify(accountTokens("refreshed-access", options.refreshAfterThread))}})); if (${!!options.replaceAfterThread}) writeFileSync(${JSON.stringify(join(dir, '.codex/auth.json'))}, JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'replacement',refresh_token:'replacement'}})); send({thread:{id:m.params.threadId ?? 'native-thread'},modelProvider:${JSON.stringify(modelProvider)}}); }
 else if(m.method==='thread/delete') { if (${!!options.threadDeleteFails}) console.log(JSON.stringify({id:m.id,error:{code:-32603,message:'synthetic delete failure'}})); else send({}); }
 else if(m.method==='turn/start') { send({turn:{id:'turn-1'}}); console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed',items:[]}}})); if (${!!options.unexpectedOutputClose}) process.stdout.end(); }
}
`); await chmod(executable, 0o700);
  const launch = buildAgentLaunch({ agent: "codex", cwd: dir, runtimeHome: dir, prompt: "synthetic only", codexExecutable: executable,
    sandbox: { enabled: true, mode: "workspace-write" }, providerEventPath: join(dir, "events.jsonl"), ...(resume ? { providerThreadId: "existing-thread" } : {}), nativeCodexSubscription: { codexHome: join(dir, ".codex"), expectedPrincipalFingerprint, expectedConsentRevision: 1, expectedConfigurationFingerprint: nativeCodexConfigurationFingerprint(row), expectedHarnessInstanceId: row.id, expectedAccountId: row.selectedAccountId } });
  const child = spawn(launch.command, launch.args, { cwd: dir, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let observing = false;
    const cleanup = () => { settled = true; clearTimeout(timer); clearInterval(observer); };
    // app-server is persistent. Stop the fixture only after Matrix has persisted
    // completion, instead of making provider EOF race its process-close event.
    const observer = setInterval(async () => {
      if (settled || observing || options.unexpectedOutputClose) return;
      observing = true;
      try {
        const events = await readFile(join(dir, "events.jsonl"), "utf8");
        if (!settled && events.includes('"type":"turn.completed"')) {
          clearInterval(observer);
          child.kill("SIGTERM");
        }
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          cleanup(); reject(error); child.kill("SIGKILL");
        }
      } finally { observing = false; }
    }, 10);
    const timer = setTimeout(() => {
      cleanup();
      // Reject before killing: close can fire before asynchronous diagnostics finish
      // and a null exit code must never satisfy a negative-admission assertion.
      reject(new Error(`fixture timed out ${errors}`));
      child.kill("SIGKILL");
    }, 5000);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); resolve(code); });
  });
  const messages = (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const events = await readFile(join(dir, "events.jsonl"), "utf8").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return { code, messages, events, stderr: errors, diagnostics: JSON.stringify({ code, stderr: errors, events, methods: messages.map(message => message.method ?? message.shutdown ?? "spawn") }) };
}
type FixtureResult = Awaited<ReturnType<typeof fixture>>;
const ACCOUNT_A = { type: "chatgpt", email: "owner@example.test", id: "account-a" };
// The account proof runs concurrently with thread/start (or resume); the
// invariant is that no model request (turn/start) and no persisted
// thread.started happen before the proof succeeds, and a failed proof fails
// closed exactly as before: exit 1, one turn.failed event, nothing on stderr,
// and the provider child stopped.
function expectRejectedBeforeInference(result: FixtureResult) {
  const { code, messages, events, stderr, diagnostics } = result;
  expect(code, diagnostics).toBe(1);
  expect(events, diagnostics).toBe('{"type":"turn.failed"}\n');
  expect(events, diagnostics).not.toContain('"type":"thread.started"');
  expect(stderr, diagnostics).toBe("");
  expect(messages.some(m => m.method === "turn/start"), diagnostics).toBe(false);
  expect(messages, diagnostics).toContainEqual({ shutdown: "SIGTERM" });
}
/** A never-recorded new thread is deleted before the child stops; a resumed thread is never deleted. */
function expectUnrecordedThreadDiscarded(result: FixtureResult, resume: boolean) {
  const { messages, diagnostics } = result;
  const deletes = messages.filter(m => m.method === "thread/delete");
  if (resume) { expect(deletes, diagnostics).toEqual([]); return; }
  expect(messages.some(m => m.method === "thread/start"), diagnostics).toBe(true);
  expect(deletes.map(m => m.params), diagnostics).toEqual([{ threadId: "native-thread" }]);
  expect(messages.indexOf(deletes[0]), diagnostics).toBeLessThan(messages.findIndex(m => m.shutdown === "SIGTERM"));
}
describe("native subscription runner admission before inference", () => {
  it.each([false, true])("verifies native account and actual provider before turn start for resume=%s", async resume => {
    const { code, messages, events, diagnostics } = await fixture(ACCOUNT_A, "openai", resume);
    expect(code, diagnostics).toBe(0);
    const methods = messages.map(m => m.method).filter(Boolean);
    expect(methods).toContain(resume ? "thread/resume" : "thread/start");
    expect(methods).toContain("turn/start");
    expect(methods.indexOf("config/read")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("account/read")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods).not.toContain("thread/delete");
    expect(events).toContain('"type":"thread.started"');
    expect(messages.find(m => m.method === "account/read").params).toEqual({ refreshToken: false });
    expect(messages.find(m => m.method === "config/read").params.cwd).toBe(await realpath(messages[0].env.HOME));
  });
  it.each([null, { type: "apiKey" }])("rejects non-subscription account %j before inference", async account => {
    const result = await fixture(account, "openai");
    expect(result.messages.some(m => m.method === "account/read"), result.diagnostics).toBe(true);
    expectRejectedBeforeInference(result);
    expectUnrecordedThreadDiscarded(result, false);
  });
  it.each([false, true])("rejects actual custom provider on resume=%s before turn/start", async resume => {
    const { code, messages, diagnostics } = await fixture(ACCOUNT_A, "funded-custom", resume);
    expect(code, diagnostics).not.toBe(0);
    expect(messages.some(m => m.method === (resume ? "thread/resume" : "thread/start"))).toBe(true);
    expect(messages.some(m => m.method === "turn/start")).toBe(false);
  });
});

it.each([false, true])("rejects a different native principal before inference (resume=%s)", async resume => {
  const result = await fixture({ ...ACCOUNT_A, id: "account-b" }, "openai", resume);
  expect(result.messages.some(m => m.method === "account/read"), result.diagnostics).toBe(true);
  expectRejectedBeforeInference(result);
  expectUnrecordedThreadDiscarded(result, resume);
});
it("fails closed with the same outcome when discarding the unrecorded thread fails", async () => {
  const result = await fixture({ ...ACCOUNT_A, id: "account-b" }, "openai", false, { threadDeleteFails: true });
  const { code, messages, events, diagnostics } = result;
  expect(code, diagnostics).toBe(1);
  expect(events, diagnostics).toBe('{"type":"turn.failed"}\n');
  expect(messages.some(m => m.method === "turn/start"), diagnostics).toBe(false);
  expect(messages.some(m => m.method === "thread/delete"), diagnostics).toBe(true);
  expect(messages, diagnostics).toContainEqual({ shutdown: "SIGTERM" });
  expect(result.stderr, diagnostics).toContain("Unrecorded Codex thread discard skipped: thread_delete");
  expect(result.stderr, diagnostics).not.toContain("synthetic delete failure");
});
it("rejects a principal switch between thread creation and the first turn", async () => {
  const { code, messages, diagnostics } = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai", false, { nextAccount: { type: "chatgpt", email: "owner@example.test", id: "account-b" } });
  expect(code, diagnostics).not.toBe(0); expect(messages.some(m => m.method === "thread/start")).toBe(true); expect(messages.some(m => m.method === "turn/start")).toBe(false);
});
it.each([false, true])("rechecks protected file generation before the first turn (replaced=%s)", async replaceAfterThread => {
  const { code, messages, diagnostics } = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai", false, { file: true, replaceAfterThread });
  expect(code === 0, diagnostics).toBe(!replaceAfterThread); expect(messages.some(m => m.method === "turn/start")).toBe(!replaceAfterThread);
});
// ENG-523: Codex rewrites auth.json when it refreshes tokens; the account is unchanged.
it.each([["account-file-a", true], ["account-file-b", false]] as const)("admits a token refresh of the same credential account before the first turn (%s)", async (refreshedAccount, admitted) => {
  const { code, messages, diagnostics } = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai", false,
    { file: true, credentialAccountId: "account-file-a", refreshAfterThread: refreshedAccount });
  expect(code === 0, diagnostics).toBe(admitted); expect(messages.some(m => m.method === "turn/start")).toBe(admitted);
});
// ENG-523: a chat admitted under legacy consent resumes after the same-account
// upgrade alias is recorded; it never resumes for an unaliased or other account.
it.each([["aliased", true], ["unaliased", false], ["other-account", false]] as const)("resumes legacy consent only through its same-account alias (%s)", async (legacyConsent, admitted) => {
  const { code, messages, diagnostics } = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai", true,
    { file: true, credentialAccountId: "account-file-a", refreshAfterThread: "account-file-a", legacyConsent });
  expect(code === 0, diagnostics).toBe(admitted); expect(messages.some(m => m.method === "turn/start")).toBe(admitted);
});
it("rejects effective managed provider override before inference", async () => {
  const result = await fixture(ACCOUNT_A, "openai", false, { configuredProvider: "paid-proxy" });
  expect(result.messages.some(m => m.method === "config/read"), result.diagnostics).toBe(true);
  expectRejectedBeforeInference(result);
  expectUnrecordedThreadDiscarded(result, false);
});

it.each(['off', 'reconnected', 'uncertain', 'route', 'model'] as const)('fences delayed spawn after %s even with unchanged credentials', async revokeKind => {
  const { code, messages, diagnostics } = await fixture({ type: 'chatgpt', email: 'owner@example.test', id: 'account-a' }, 'openai', false, { revokeAt: 'before-spawn', revokeKind });
  expect(code, diagnostics).not.toBe(0);
  expect(messages.some(m => m.method === 'thread/start' || m.method === 'turn/start')).toBe(false);
});
it.each(['off', 'reconnected', 'uncertain', 'route', 'model'] as const)('rechecks saved consent before the first turn after %s', async revokeKind => {
  const { code, messages, diagnostics } = await fixture({ type: 'chatgpt', email: 'owner@example.test', id: 'account-a' }, 'openai', false, { revokeAt: 'after-thread', revokeKind });
  expect(code, diagnostics).not.toBe(0);
  expect(messages.some(m => m.method === 'thread/start')).toBe(true);
  expect(messages.some(m => m.method === 'turn/start')).toBe(false);
});

it.each(['before-spawn', 'after-thread'] as const)('keeps native consent after presentation changes %s', async revokeAt => {
  const { code, messages, diagnostics } = await fixture({ type: 'chatgpt', email: 'owner@example.test', id: 'account-a' }, 'openai', false, { revokeAt, revokeKind: 'presentation' });
  expect(code, diagnostics).toBe(0);
  expect(messages.some(m => m.method === 'turn/start')).toBe(true);
});

it("keeps the fake app-server alive until the runner finishes its turn and requests shutdown", async () => {
  const result = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai");
  expect(result.code, result.diagnostics).toBe(0);
  expect(result.messages, result.diagnostics).toContainEqual({ shutdown: "SIGTERM" });
});

it("fails closed if a provider closes output while the runner still accepts continuations", async () => {
  const result = await fixture({ type: "chatgpt", email: "owner@example.test", id: "account-a" }, "openai", false, { unexpectedOutputClose: true });
  expect(result.events, result.diagnostics).toContain('"type":"turn.completed"');
  expect(result.code, result.diagnostics).toBe(1);
  expect(result.messages, result.diagnostics).toContainEqual({ shutdown: "SIGTERM" });
});
