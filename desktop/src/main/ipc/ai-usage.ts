import { scanUsageRoots, usageRoots } from "@matrix-os/contracts/ai-usage/node";
import { AI_USAGE_INVOKE } from "../../shared/ai-usage-ipc";
interface Auth {
  getStatus(): {
    signedIn: boolean;
    userId?: string;
    runtimeSlot: string;
    authGeneration: number;
  };
}
/** No renderer-controlled paths. Results cannot outlive their authenticated generation. */
export function registerAiUsageIpc(
  ipc: {
    handle(
      channel: string,
      listener: (event: unknown, input: unknown) => Promise<unknown>,
    ): void;
  },
  options: {
    home: string;
    /** Agent folders configured for this Mac's main process; never renderer input. */
    roots?: { codexRoot?: string; claudeRoot?: string };
    auth: Auth;
    isTrusted(event: unknown): boolean;
    scan?: typeof scanUsageRoots;
    sync?: {
      sync(input: {
        runtimeSlot: string;
        authGeneration: number;
      }): Promise<unknown>;
      cancel(): void;
      dispose(): Promise<void>;
    };
  },
) {
  if (!options.auth || !options.home || typeof options.isTrusted !== "function")
    throw new Error("Usage unavailable");
  const scan = options.scan ?? scanUsageRoots;
  let operation: {
    key: string;
    controller: AbortController;
    task: ReturnType<typeof scanUsageRoots>;
  } | null = null;
  const cancel = () => {
    operation?.controller.abort();
    options.sync?.cancel();
  };
  ipc.handle("runtime:ai-usage-sync", async (event, input) => {
    if (!options.isTrusted(event)) throw new Error("Invalid request");
    const request =
      AI_USAGE_INVOKE["runtime:ai-usage-sync"].request.parse(input);
    if (!options.sync) return { status: "unpaired" as const };
    try {
      return AI_USAGE_INVOKE["runtime:ai-usage-sync"].response.parse(
        await options.sync.sync(request),
      );
    } catch (error: unknown) {
      console.warn(
        "[ai-usage] sync unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new Error("Usage sync unavailable");
    }
  });
  ipc.handle("runtime:ai-usage", async (event, input) => {
    if (!options.isTrusted(event)) throw new Error("Invalid request");
    const parsed = AI_USAGE_INVOKE["runtime:ai-usage"].request.safeParse(input);
    if (!parsed.success) throw new Error("Invalid request");
    const request = parsed.data,
      owner = options.auth.getStatus();
    if (
      !owner.signedIn ||
      !owner.userId ||
      owner.runtimeSlot !== request.runtimeSlot ||
      owner.authGeneration !== request.authGeneration
    )
      throw new Error("Usage unavailable");
    const key = `${owner.userId}:${owner.runtimeSlot}:${owner.authGeneration}`;
    if (operation && (operation.key !== key || operation.controller.signal.aborted)) {
      // A scan for the previous account or computer must finish stopping before this one starts,
      // otherwise the new owner would be refused until they asked again.
      const stale = operation;
      stale.controller.abort();
      try {
        await stale.task;
      } catch (error: unknown) {
        console.warn(
          "[ai-usage] previous scan stopped",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
      if (operation === stale) operation = null;
      const live = options.auth.getStatus();
      if (
        !live.signedIn ||
        `${live.userId}:${live.runtimeSlot}:${live.authGeneration}` !== key
      )
        throw new Error("Usage unavailable");
    }
    if (!operation) {
      const controller = new AbortController();
      operation = {
        key,
        controller,
        task: scan(
          usageRoots(options.home, options.roots),
          AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        ),
      };
    }
    const current = operation;
    try {
      const result = await current.task;
      const live = options.auth.getStatus();
      if (
        current.controller.signal.aborted ||
        !live.signedIn ||
        `${live.userId}:${live.runtimeSlot}:${live.authGeneration}` !== key
      )
        throw new Error("Stale usage");
      return AI_USAGE_INVOKE["runtime:ai-usage"].response.parse(result);
    } catch (error: unknown) {
      console.warn(
        "[ai-usage] native scan unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new Error("Usage unavailable");
    } finally {
      if (operation === current) operation = null;
    }
  });
  return {
    cancel,
    async dispose() {
      operation?.controller.abort();
      await options.sync?.dispose();
      try {
        await operation?.task;
      } catch (error: unknown) {
        console.warn(
          "[ai-usage] scan cancelled",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    },
  };
}
