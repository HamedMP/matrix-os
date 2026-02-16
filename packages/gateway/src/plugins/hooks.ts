import type {
  HookName,
  RegisteredHook,
  ModifyingHookResult,
  VOID_HOOKS,
  MODIFYING_HOOKS,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

const DEFAULT_HOOK_TIMEOUT = 5000;

export interface HookRunner {
  fireVoidHook(event: HookName, context: Record<string, unknown>): Promise<void>;
  fireModifyingHook<T extends ModifyingHookResult>(
    event: HookName,
    context: Record<string, unknown>,
  ): Promise<T | undefined>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Hook timeout: ${label} exceeded ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function createHookRunner(
  registry: PluginRegistry,
  opts?: { timeout?: number },
): HookRunner {
  const timeout = opts?.timeout ?? DEFAULT_HOOK_TIMEOUT;

  return {
    async fireVoidHook(event, context) {
      const hooks = registry.getHooks(event);
      if (hooks.length === 0) return;

      const results = await Promise.allSettled(
        hooks.map((hook) =>
          withTimeout(
            (async () => hook.handler(context))(),
            timeout,
            `${hook.pluginId}:${event}`,
          ),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "rejected") {
          console.error(`[plugin:${hooks[i].pluginId}] Hook ${event} error: ${r.reason}`);
        }
      }
    },

    async fireModifyingHook<T extends ModifyingHookResult>(
      event: HookName,
      context: Record<string, unknown>,
    ): Promise<T | undefined> {
      const hooks = registry.getHooks(event);
      if (hooks.length === 0) return undefined;

      let merged: T | undefined;

      for (const hook of hooks) {
        try {
          const result = await withTimeout(
            (async () => hook.handler(context))(),
            timeout,
            `${hook.pluginId}:${event}`,
          );
          if (result && typeof result === "object") {
            merged = merged ? { ...merged, ...result } as T : result as T;
          }
        } catch (err) {
          console.error(`[plugin:${hook.pluginId}] Hook ${event} error: ${err}`);
        }
      }

      return merged;
    },
  };
}
