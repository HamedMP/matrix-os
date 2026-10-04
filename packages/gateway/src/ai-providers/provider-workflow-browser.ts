import { spawn } from "node:child_process";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import { ProviderWorkflowError, ProviderWorkflowCodeNotAcceptedError } from "./provider-workflows.js";

type Publish = (update: Partial<Pick<ProviderWorkflow, "state" | "authorizationUrl" | "safeFailure">>) => void;
/** Claude Code 2.1.280 uses these exact OAuth authorization endpoints. */
export function extractClaudeAuthorizationUrl(raw: string): string | null {
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-16384);
  for (const candidate of text.match(/https:\/\/[^\s\x1b]+/g) ?? []) {
    if (candidate.length > 2048) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) continue;
      if ((url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize")
        || (url.hostname === "platform.claude.com" && url.pathname === "/oauth/authorize")) return url.href;
    } catch (error) { if (!(error instanceof TypeError)) console.warn("[provider-workflow] Invalid authorization URL"); }
  }
  return null;
}

/** The native CLI owns PKCE/state and persistence; foreground code stays transient. */
export function createClaudeSettingsLogin(options: {
  command: string; args?: string[]; cwd: string; env: Record<string, string>;
  acquire: () => Promise<() => void | Promise<void>>;
}) {
  return async ({ publish, onSuccess, registerCleanup }: { publish: Publish; onSuccess: () => Promise<void>; registerCleanup?: (cancel: () => Promise<void>) => void }) => {
    const release = await options.acquire();
    const launching: { child?: ReturnType<typeof spawn> } = {};
    registerCleanup?.(async () => { if (!launching.child) { await release(); return; } await stop(); });
    const child = launching.child = spawn(options.command, options.args ?? ["auth", "login", "--claudeai"], {
      cwd: options.cwd, env: { ...options.env, BROWSER: "/bin/true" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stopped = false; let cancelled = false; let submitted = false;
    let outputBytes = 0; let buffer = ""; let authorizationUrl: string | null = null;
    let finishTask: Promise<void> | undefined;
    let closed!: () => void;
    const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    const deadline = setTimeout(() => { void stop().then(() => publish({ state: "expired", safeFailure: "expired" })).catch(error => { console.warn("[provider-workflow] Browser cleanup unavailable:", error instanceof Error ? error.name : "UnknownError"); publish({ safeFailure: "unavailable" }); }); }, 600000);
    deadline.unref();
    async function stop() {
      if (finishTask) { await finishTask; return; }
      cancelled = true;
      child!.kill("SIGTERM");
      const force = setTimeout(() => child!.kill("SIGKILL"), 1000); force.unref();
      let bounded: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closedPromise, new Promise<never>((_, reject) => {
          bounded = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 5000); bounded.unref();
        })]);
        await finishTask;
      } finally { clearTimeout(force); if (bounded) clearTimeout(bounded); }
    }
    const onData = (chunk: Buffer) => {
      if (stopped || cancelled) return;
      outputBytes += chunk.length;
      if (outputBytes > 65536) { void stop().then(() => publish({ state: "failed", safeFailure: "unavailable" })).catch(error => console.warn("[provider-workflow] Output cleanup unavailable:", error instanceof Error ? error.name : "UnknownError")); return; }
      buffer = (buffer + chunk.toString("utf8")).slice(-16384);
      const url = extractClaudeAuthorizationUrl(buffer);
      if (url && !authorizationUrl) { authorizationUrl = url; publish({ authorizationUrl: url }); }
    };
    child!.stdout!.on("data", onData); child!.stderr!.on("data", onData);
    child!.stdin!.on("error", error => { console.warn("[provider-workflow] Browser input unavailable:", error.name); void stop().then(() => publish({ state: "failed", safeFailure: "unavailable" })).catch(caught => console.warn("[provider-workflow] Input cleanup unavailable:", caught instanceof Error ? caught.name : "UnknownError")); });
    child!.on("error", error => console.warn("[provider-workflow] Browser process unavailable:", error.name));
    child!.on("close", code => {
      stopped = true; clearTimeout(deadline); buffer = ""; closed();
      finishTask = (async () => {
        try {
          if (cancelled) return;
          if (code !== 0 || !authorizationUrl) throw new ProviderWorkflowError("unavailable");
          await onSuccess(); publish({ state: "succeeded", safeFailure: null });
        } catch (error) { console.warn("[provider-workflow] Browser completion unavailable:", error instanceof Error ? error.name : "UnknownError"); publish({ state: "failed", safeFailure: "unavailable" }); }
        finally { await release(); }
      })();
    });
    return {
      cancel: stop,
      async submitCode(code: string) {
        if (stopped || cancelled || submitted || !authorizationUrl || !/^[A-Za-z0-9._~+\/=\-]+(?:#[A-Za-z0-9._~\-]+)?$/.test(code) || code.length > 4096) throw new ProviderWorkflowCodeNotAcceptedError("conflict");
        submitted = true;
        await new Promise<void>((accept, reject) => child!.stdin!.write(`${code}\n`, error => error ? reject(new ProviderWorkflowError("unavailable")) : accept()));
      },
    };
  };
}
