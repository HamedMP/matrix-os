import type { MailAction } from "./types";
interface Options {
  call(action: MailAction, payload: Record<string, unknown>): Promise<unknown>;
  performAction<T>(operation: () => Promise<T>): Promise<T | null>;
  offline: boolean;
  preview: boolean;
  reload(): Promise<void>;
  notice(message: string): void;
  purgeSource(sourceId: string): Promise<void>;
  resetPolling(): void;
}
export function editionSourceActions(options: Options) {
  return {
    async sync(sourceId: string) {
      if (options.offline) return;
      options.resetPolling();
      await options.performAction(async () => {
        const raw = await options.call("sync", { sourceId });
        options.notice(
          (raw as { state?: string })?.state === "completed"
            ? "Sync complete. Your library is up to date."
            : "Sync started. Saved emails are kept available while new editions arrive.",
        );
      });
      await options.reload();
    },
    async retention(sourceId: string, mode: "keep" | "purge") {
      if (options.offline || options.preview) return false;
      const result = await options.performAction(async () => {
        const raw = await options.call("retention", { sourceId, mode });
        if (
          !raw ||
          typeof raw !== "object" ||
          (raw as { paused?: unknown }).paused !== true ||
          (raw as { purged?: unknown }).purged !== (mode === "purge")
        )
          throw new Error("Account change unconfirmed");
        if (mode === "purge") await options.purgeSource(sourceId);
        options.notice(
          mode === "purge"
            ? "Retained history removed. Your source email is unchanged."
            : "Importing stopped. Retained editions remain available. Add this account again to resume.",
        );
        return true;
      });
      if (!result) return false;
      await options.reload();
      return true;
    },
  };
}
