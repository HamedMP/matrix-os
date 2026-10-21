import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { z } from "zod/v4";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import type { NativeAccountCompletionProof } from "./native-account-metadata-binding.js";
import { ProviderWorkflowError } from "./provider-workflows.js";

type Publish = (update: Partial<Pick<ProviderWorkflow, "state" | "authorizationUrl" | "deviceCode" | "safeFailure">>) => void;
type SpawnObserver = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
const DeviceResponse = z.object({ type: z.literal("chatgptDeviceCode"), loginId: z.uuid(),
  verificationUrl: z.literal("https://auth.openai.com/codex/device"), userCode: z.string().regex(/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/) });

const CurrentAccount = z.object({ account: z.discriminatedUnion("type", [
  z.object({ type: z.literal("chatgpt"), email: z.email().max(120), planType: z.string().max(64) }),
  z.object({ type: z.literal("apiKey") }),
]).nullable() });
const LoginCompleted = z.object({ loginId: z.uuid().nullable().optional(), success: z.boolean() });

/** Native account RPC preserves the current account until successful consent.
 * `codex login --device-auth` clears it before consent, so it is unsafe here.
 * Codex owns credentials, OAuth policy and persistence; no credentials are read.
 */
export function createCodexSettingsLogin(options: {
  command: string; args?: string[]; cwd: string; env: Record<string, string>;
  acquire: () => Promise<() => void | Promise<void>>;
  captureAccountProof?: (spawnObserver: SpawnObserver) => Promise<NativeAccountCompletionProof>;
}) {
  return async ({ publish, onSuccess, registerCleanup }: { publish: Publish; onSuccess: (proof: NativeAccountCompletionProof | undefined, current: () => boolean) => Promise<void>; registerCleanup?: (cancel: () => Promise<void>) => void }) => {
    const release = await options.acquire();
    let releaseTask: Promise<void> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let closed = false;
    const observers = new Set<{ child: ChildProcessWithoutNullStreams; closed: boolean; exited: Promise<void> }>();
    const allClosed = () => (!child || closed) && observers.size === 0;
    const releaseProfile = () => allClosed()
      ? releaseTask ??= Promise.resolve().then(release)
      : Promise.reject(new ProviderWorkflowError("unavailable"));
    registerCleanup?.(async () => { if (!child) { await releaseProfile(); return; } await stop(); });
    try { child = spawn(options.command, options.args ?? ["app-server", "--stdio"], {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }); } catch (error) { await releaseProfile(); throw error; }
    let buffer = "", bytes = 0, loginId: string | null = null;
    let cancelled = false, completed = false, settled = false;
    let earlyCompletion: z.infer<typeof LoginCompleted> | undefined;
    let finishTask: Promise<boolean> | undefined, stopTask: Promise<void> | undefined;
    let signalClose!: () => void;
    const closePromise = new Promise<void>(resolve => { signalClose = resolve; });
    const send = (id: number, method: string, params: unknown) => {
      if (!closed) child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    };
    const reapChild = async (process: ReturnType<typeof spawn>, hasClosed: () => boolean, exited: Promise<void>) => {
      if (hasClosed()) return;
      process.kill("SIGTERM");
      const force = setTimeout(() => process.kill("SIGKILL"), 1000); force.unref();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 5000); timeout.unref();
      })]); } finally { clearTimeout(force); clearTimeout(timeout); }
    };
    const reap = async () => {
      await reapChild(child!, () => closed, closePromise);
      for (const observer of [...observers]) await reapChild(observer.child, () => observer.closed, observer.exited);
    };
    const spawnObserver: SpawnObserver = (command, args, options) => {
      // Native metadata verification is sequential. Bound pending close receipts
      // too, since its reader may resolve on exit before stdio has closed.
      if (observers.size >= 4) throw new ProviderWorkflowError("unavailable");
      const process = spawn(command, args, options);
      let signalExit!: () => void;
      const observer = { child: process, closed: false, exited: new Promise<void>(resolve => { signalExit = resolve; }) };
      observers.add(observer);
      process.once("close", () => {
        observer.closed = true; observers.delete(observer); signalExit();
        if (settled && allClosed()) void Promise.resolve(finishTask).then(releaseProfile).catch(error =>
          console.warn("[provider-workflow] Codex observer lease release unavailable:", error instanceof Error ? error.name : "UnknownError"));
      });
      return process;
    };
    const finish = (success: boolean) => {
      if (settled) return finishTask;
      settled = true; clearTimeout(deadline); clearTimeout(startup);
      finishTask = (async () => {
        try {
          await reap();
          let proof: NativeAccountCompletionProof | undefined;
          try { if (success && !cancelled) proof = await options.captureAccountProof?.(spawnObserver); }
          finally { await reap(); await releaseProfile(); }
          if (cancelled) return true;
          if (!success) throw new ProviderWorkflowError("unavailable");
          await onSuccess(proof, () => !cancelled); publish({ state: "succeeded", safeFailure: null });
          return true;
        } catch (error) {
          console.warn("[provider-workflow] Codex connection unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!cancelled) publish(allClosed() ? { state: "failed", safeFailure: "unavailable" } : { safeFailure: "unavailable" });
          return false;
        }
      })();
      return finishTask;
    };
    const stop = () => {
      // Native authentication is not yet the canonical private completion.
      // Fence cancellation while proof/lease cleanup is still awaiting; once
      // the private completion write has actually dispatched, await its real outcome.
      cancelled = true;
      if (completed) return finishTask?.then(async success => {
        if (!success && !allClosed()) throw new ProviderWorkflowError("unavailable");
        if (allClosed()) await releaseProfile();
      }) ?? Promise.reject(new ProviderWorkflowError("unavailable"));
      if (stopTask) return stopTask;
      clearTimeout(deadline); clearTimeout(startup);
      stopTask = (async () => {
        // A failed cleanup remains retryable, without reopening native login.
        if (settled) { await reap(); await releaseProfile(); return; }
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
    child!.stdin!.on("error", () => { void finish(false); });
    child!.on("error", () => { void finish(false); });
    child!.on("close", () => {
      closed = true; buffer = ""; signalClose();
      if (!settled) void finish(completed);
      // A late close after uncertain reaping releases only after any active
      // completion has captured its owner-bound proof under this same lease.
      else if (allClosed()) void Promise.resolve(finishTask).then(releaseProfile).catch(error => console.warn("[provider-workflow] Codex lease release unavailable:", error instanceof Error ? error.name : "UnknownError"));
    });
    child!.stderr!.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) void finish(false); });
    child!.stdout!.setEncoding("utf8");
    child!.stdout!.on("data", (chunk: string) => {
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
          child!.stdin!.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          send(4, "account/read", { refreshToken: false });
        } else if (message.id === 4) {
          const parsed = CurrentAccount.safeParse(message.result);
          if (message.error || !parsed.success || parsed.data.account?.type === "apiKey") { void finish(false); return; }
          // Never silently replace the existing owner principal or native key.
          // Fresh canonical completion independently verifies this native identity.
          if (parsed.data.account?.type === "chatgpt") { completed = true; void finish(true); return; }
          send(2, "account/login/start", { type: "chatgptDeviceCode" });
        } else if (message.id === 2) {
          const parsed = DeviceResponse.safeParse(message.result);
          if (message.error || !parsed.success) { void finish(false); return; }
          loginId = parsed.data.loginId; clearTimeout(startup);
          if (earlyCompletion?.loginId === loginId) { completed = earlyCompletion.success; void finish(completed); return; }
          earlyCompletion = undefined;
          if (!cancelled) publish({ authorizationUrl: parsed.data.verificationUrl, deviceCode: parsed.data.userCode });
        } else if (message.id === 3) acknowledge();
        else if (!cancelled && message.method === "account/login/completed") {
          const parsed = LoginCompleted.safeParse(message.params);
          if (!parsed.success) { void finish(false); return; }
          if (!loginId) {
            // Official completion can precede the start reply. Retain at most
            // one bounded notification; only its exact returned UUID can win.
            if (earlyCompletion) { void finish(false); return; }
            earlyCompletion = parsed.data;
          } else if (parsed.data.loginId === loginId) {
            completed = parsed.data.success; void finish(completed); return;
          }
        }
      }
    });
    send(1, "initialize", { clientInfo: { name: "matrix-os-settings", version: "1.0.0" }, capabilities: {} });
    return { cancel: stop };
  };
}
