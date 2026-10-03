import { spawn } from "node:child_process";
import { z } from "zod/v4";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import { ProviderWorkflowError } from "./provider-workflows.js";

type Publish = (update: Partial<Pick<ProviderWorkflow, "state" | "authorizationUrl" | "deviceCode" | "safeFailure">>) => void;
const DeviceResponse = z.object({ type: z.literal("chatgptDeviceCode"), loginId: z.string().min(1).max(128),
  verificationUrl: z.literal("https://auth.openai.com/codex/device"), userCode: z.string().regex(/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/) });

/** Native account RPC preserves the current account until successful consent.
 * `codex login --device-auth` clears it before consent, so it is unsafe here.
 * Codex owns credentials, OAuth policy and persistence; no credentials are read.
 */
export function createCodexSettingsLogin(options: {
  command: string; args?: string[]; cwd: string; env: Record<string, string>;
  acquire: () => Promise<() => void>;
}) {
  return async ({ publish, onSuccess }: { publish: Publish; onSuccess: () => Promise<void> }) => {
    const release = await options.acquire();
    let released = false;
    const releaseProfile = () => { if (!released) { released = true; release(); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(options.command, options.args ?? ["app-server", "--stdio"], {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }); } catch (error) { releaseProfile(); throw error; }
    let buffer = "", bytes = 0, loginId: string | null = null;
    let cancelled = false, completed = false, closed = false, settled = false;
    let finishTask: Promise<boolean> | undefined, stopTask: Promise<void> | undefined;
    let signalClose!: () => void;
    const closePromise = new Promise<void>(resolve => { signalClose = resolve; });
    const send = (id: number, method: string, params: unknown) => {
      if (!closed) child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    };
    const reap = async () => {
      if (closed) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000); force.unref();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closePromise, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 5000); timeout.unref();
      })]); } finally { clearTimeout(force); clearTimeout(timeout); }
    };
    const finish = (success: boolean) => {
      if (settled) return finishTask;
      settled = true; clearTimeout(deadline); clearTimeout(startup);
      finishTask = (async () => {
        try {
          await reap(); releaseProfile();
          if (cancelled) return true;
          if (!success) throw new ProviderWorkflowError("unavailable");
          await onSuccess(); publish({ state: "succeeded", safeFailure: null });
          return true;
        } catch (error) {
          console.warn("[provider-workflow] Codex connection unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!cancelled) publish({ state: "failed", safeFailure: "unavailable" });
          return false;
        }
      })();
      return finishTask;
    };
    const stop = () => {
      if (completed) return finishTask?.then(() => {}) ?? Promise.resolve();
      if (stopTask) return stopTask;
      cancelled = true; clearTimeout(deadline); clearTimeout(startup);
      stopTask = (async () => {
        // A failed cleanup remains retryable, without reopening native login.
        if (settled) { await reap(); releaseProfile(); return; }
        // Request native cancellation first; give it an acknowledgement before
        // reaping. Killing the scoped server also drops its active login.
        if (loginId && !closed) {
          send(3, "account/login/cancel", { loginId });
          await Promise.race([cancelAck, new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 250); timer.unref();
          })]);
        }
        if (await finish(false) === false) throw new ProviderWorkflowError("unavailable");
      })().catch(error => { stopTask = undefined; throw error; });
      return stopTask;
    };
    let acknowledge!: () => void;
    const cancelAck = new Promise<void>(resolve => { acknowledge = resolve; });
    const startup = setTimeout(() => { void finish(false); }, 30000); startup.unref();
    const deadline = setTimeout(() => {
      void stop().then(() => publish({ state: "expired", safeFailure: "expired" })).catch(error => {
        console.warn("[provider-workflow] Codex expiry unavailable:", error instanceof Error ? error.name : "UnknownError");
        publish({ safeFailure: "unavailable" });
      });
    }, 600000); deadline.unref();
    child.stdin!.on("error", () => { void finish(false); });
    child.on("error", () => { void finish(false); });
    child.on("close", () => { closed = true; buffer = ""; releaseProfile(); signalClose(); if (!settled) void finish(completed); });
    child.stderr!.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) void finish(false); });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 65536) { void finish(false); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: { id?: number; method?: string; result?: unknown; params?: { loginId?: string; success?: boolean }; error?: unknown };
        try { message = JSON.parse(line); } catch (error) {
          console.warn("[provider-workflow] Invalid Codex response:", error instanceof Error ? error.name : "UnknownError");
          void finish(false); return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) { void finish(false); return; }
        if (message.id === 1) {
          if (message.error) { void finish(false); return; }
          child.stdin!.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          send(2, "account/login/start", { type: "chatgptDeviceCode" });
        } else if (message.id === 2) {
          const parsed = DeviceResponse.safeParse(message.result);
          if (message.error || !parsed.success) { void finish(false); return; }
          loginId = parsed.data.loginId; clearTimeout(startup);
          if (!cancelled) publish({ authorizationUrl: parsed.data.verificationUrl, deviceCode: parsed.data.userCode });
        } else if (message.id === 3) acknowledge();
        else if (!cancelled && message.method === "account/login/completed" && loginId && message.params?.loginId === loginId) {
          completed = message.params.success === true; void finish(completed); return;
        }
      }
    });
    send(1, "initialize", { clientInfo: { name: "matrix-os-settings", version: "1.0.0" }, capabilities: {} });
    return { cancel: stop };
  };
}
