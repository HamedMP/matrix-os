import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";

type Change = Parameters<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>[0];
type Request = { nativeRequestId: string; toolName: string; input: Record<string, unknown> };
type Respond = (value: unknown) => Promise<void>;
const Envelope = z.object({ type: z.literal("control_response"), response: z.object({
  request_id: z.string().min(1).max(256), subtype: z.enum(["success", "error"]), response: z.unknown().optional(),
}) });

/** Owner-authorized, run-lifetime native controls. No model frame can call change(). */
export function createClaudePermissionControl(options: {
  chatId: string; runId: string; initialMode: string; enabled: boolean; signal: AbortSignal;
  verify?: CustomMcpApprovalClient["verifyPermissionMode"];
  write(frame: string): Promise<void>;
  supervisedSettings: Record<string, unknown>;
  setAuthority(fullAccess: boolean): Promise<void>;
  allowPending(): Promise<void>;
  dispatch(request: Request, respond: Respond): boolean;
  abort(): void;
}) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(); // max1, settled/timeout/close removal
  const queued: Array<{ request: Request; respond: Respond }> = []; // max16, drained on change or close
  let closed = false, changing = false, currentMode = options.initialMode, fullAccess = options.initialMode === "full_access";
  const unavailable = () => new Error("Permission control unavailable");
  const fail = (error: unknown) => { console.warn("[chat-claude] Permission control failed", error instanceof Error ? error.name : "UnknownError"); options.abort(); };
  function request(value: Record<string, unknown>): Promise<unknown> {
    if (closed || options.signal.aborted || pending.size) return Promise.reject(unavailable());
    const id = `permission_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(unavailable()); }, 10_000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      void options.write(`${JSON.stringify({ type: "control_request", request_id: id, request: value })}\n`).catch(error => {
        const current = pending.get(id); if (!current) return;
        pending.delete(id); clearTimeout(current.timer); current.reject(unavailable()); fail(error);
      });
    });
  }
  function allow(respond: Respond, input: Record<string, unknown>) { void respond({ behavior: "allow", updatedInput: input }).catch(fail); }
  function close() {
    if (closed) return;
    closed = true; options.signal.removeEventListener("abort", close);
    for (const current of pending.values()) { clearTimeout(current.timer); current.reject(unavailable()); }
    pending.clear();
    for (const item of queued.splice(0)) void item.respond({ behavior: "deny", message: "Permission change unavailable." }).catch(fail);
  }
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  return {
    close,
    currentMode: () => currentMode,
    cancel(nativeId: string) {
      for (let index = queued.length - 1; index >= 0; index--) if (queued[index]!.request.nativeRequestId === nativeId) queued.splice(index, 1);
    },
    handle(value: unknown): boolean {
      if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "control_response") return false;
      const raw = value as { response?: { request_id?: unknown } };
      const id = raw.response?.request_id;
      if (typeof id !== "string" || !pending.has(id)) return false;
      const current = pending.get(id)!;
      pending.delete(id); clearTimeout(current.timer);
      const parsed = Envelope.safeParse(value);
      if (!parsed.success || parsed.data.response.subtype !== "success") current.reject(unavailable());
      else current.resolve(parsed.data.response.response);
      return true;
    },
    gate(request: Request, respond: Respond): boolean {
      if (!options.enabled) return false;
      if (closed) { void respond({ behavior: "deny", message: "Permission control unavailable." }).catch(fail); return true; }
      if (changing) {
        if (queued.some(item => item.request.nativeRequestId === request.nativeRequestId)) return true;
        if (queued.length >= 16) { fail(unavailable()); return true; }
        queued.push({ request, respond }); return true;
      }
      if (fullAccess) { allow(respond, request.input); return true; }
      return false;
    },
    async change(input: Change) {
      const deadline = new AbortController();
      const timer = setTimeout(() => { deadline.abort(); options.abort(); }, 40_000);
      timer.unref?.();
      const signal = AbortSignal.any([options.signal, deadline.signal]);
      const wait = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
        const abort = () => reject(unavailable());
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
      try {
        if (!options.enabled || closed || changing || options.signal.aborted || input.chatId !== options.chatId || input.runId !== options.runId
          || !input.permissionModeProof || !options.verify || !await wait(options.verify({ chatId: input.chatId, runId: input.runId,
            clientRequestId: input.clientRequestId, permissionMode: input.permissionMode, permissionModeProof: input.permissionModeProof }))) throw unavailable();
        if (closed || options.signal.aborted || changing) throw unavailable();
        if (currentMode === input.permissionMode) { await wait(input.commit()); return; }
        changing = true;
        try {
          await wait(request({ subtype: "apply_flag_settings", settings: input.permissionMode === "full_access" ? { sandbox: { enabled: false } } : options.supervisedSettings }));
          const mode = input.permissionMode === "full_access" ? "bypassPermissions" : "default";
          const acknowledged = await wait(request({ subtype: "set_permission_mode", mode }));
          if (!z.object({ mode: z.literal(mode) }).safeParse(acknowledged).success) throw unavailable();
          await wait(options.setAuthority(input.permissionMode === "full_access"));
          if (closed || options.signal.aborted) throw unavailable();
          await wait(input.commit());
          if (closed || options.signal.aborted) throw unavailable();
          currentMode = input.permissionMode;
          fullAccess = currentMode === "full_access";
          if (fullAccess) await wait(options.allowPending());
          changing = false;
          while (queued.length) {
            const item = queued.shift()!;
            if (fullAccess) await wait(item.respond({ behavior: "allow", updatedInput: item.request.input }));
            else if (!options.dispatch(item.request, item.respond)) await wait(item.respond({ behavior: "deny", message: "Tool approval unavailable." }));
          }
        } catch (error: unknown) { close(); fail(error); throw unavailable(); }
        finally { changing = false; }
      } finally { clearTimeout(timer); }
    },
  };
}
