import { expect, it, vi } from "vitest";
import { prepareCodexBrowser } from "../../packages/gateway/src/coding-agents/codex-browser-bootstrap-client.js";
import { withNativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCodexNativeProviderSession } from "../../packages/gateway/src/coding-agents/codex-native-provider-session.mjs";
it.each([true,false])("confirms physical cleanup after an uncertain bootstrap acknowledgement (stopped=%s)",async(stopped)=>{
 const failure=new Error('Unknown acknowledgement');const prepareBrowser=vi.fn(async()=>{throw failure});const stopSession=vi.fn(async()=>({ok:stopped}));const unconfirmed=vi.fn();
 const browser={isLive:()=>true,token:'a'.repeat(43),attemptId:'123e4567-e89b-42d3-a456-426614174000',mcpServer:{env:{MATRIX_SHARED_BROWSER_GATEWAY_PORT:'4000'}}} as never;
 await expect(withNativeBrowserExecution('owner',browser,()=>prepareCodexBrowser({ownerId:'owner',sessionId:'sess_bootstrap',browser,control:{prepareBrowser} as never,runtime:{stopSession} as never,signal:new AbortController().signal}),unconfirmed)).rejects.toBe(failure);
 expect(prepareBrowser).toHaveBeenCalledTimes(1);expect(stopSession).toHaveBeenCalledOnce();expect(unconfirmed).toHaveBeenCalledTimes(stopped?0:1);
});

it.each(["typed", "untrusted_name", "expected_stop"])("keeps native stderr diagnostics safe (%s)", async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), "matrix-codex-stderr-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let session: Awaited<ReturnType<typeof startCodexNativeProviderSession>> | undefined;
  try {
    const fixture = join(home, "fixture.mjs");
    await writeFile(fixture, `import {createInterface} from 'node:readline';
      createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);
        if(request.method==='initialize') process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
      });`);
    const onFailure = vi.fn();
    session = await startCodexNativeProviderSession({ command: process.execPath, args: [fixture], cwd: home,
      env: { ...process.env, MATRIX_CODEX_STARTUP_TIMEOUT_MS: "1000" }, signal: new AbortController().signal,
      onChild() {}, onMessage() {}, onFailure });
    const failure = Object.assign(new TypeError("synthetic-secret-must-not-be-logged"), {
      code: scenario === "untrusted_name" ? "synthetic-secret-code" : "ERR_STREAM_PREMATURE_CLOSE",
      name: scenario === "untrusted_name" ? "synthetic-secret-name" : "TypeError",
    });
    const closing = scenario === "expected_stop" ? session.close() : undefined;
    session.child.stderr.destroy(failure);
    await expect(session.errors).resolves.toMatchObject({ ok: scenario === "expected_stop", error: failure });
    if (scenario === "expected_stop") {
      await closing;
      expect(onFailure).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(onFailure).toHaveBeenCalledWith(failure);
      expect(warn).toHaveBeenCalledWith("[coding-agents] Native stderr stream failed", scenario === "typed"
        ? { name: "TypeError", code: "ERR_STREAM_PREMATURE_CLOSE" } : { name: "UnknownError" });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret");
  } finally {
    await session?.close();
    warn.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
