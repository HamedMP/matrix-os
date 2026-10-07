import type {} from "../types";
import { createDemoBridge } from "./demo";
import type { MailBridge } from "./types";
export interface EditionDownloadHost {
  load(): Promise<{ scope: string; raw: string | null }>;
  save(raw: string): Promise<void>;
  clear(): Promise<void>;
}
export interface EditionRuntime {
  bridge?: MailBridge;
  preview: boolean;
  online(): boolean;
  downloads?: EditionDownloadHost;
  subscribe?(
    reload: () => void,
    offline: () => void,
    reset: () => void,
  ): () => void;
  exportContent(content: string): Promise<void>;
}
export function browserEditionRuntime(): EditionRuntime {
  const preview = new URLSearchParams(window.location.search).has("preview");
  const host = window.MatrixOS;
  const initialScope = host?.mailCacheScope;
  const legacy = initialScope
    ? {
        load: async () => ({
          scope: host.mailCacheScope!,
          raw: localStorage.getItem(
            "matrix-edition-v1:" + encodeURIComponent(host.mailCacheScope!),
          ),
        }),
        save: async (raw: string) => {
          if (host?.mailCacheScope !== initialScope)
            throw new Error("Reading session changed");
          localStorage.setItem(
            "matrix-edition-v1:" + encodeURIComponent(initialScope),
            raw,
          );
        },
        clear: async () =>
          localStorage.removeItem(
            "matrix-edition-v1:" + encodeURIComponent(initialScope),
          ),
      }
    : undefined;
  return {
    bridge: preview ? createDemoBridge() : host?.mail,
    preview,
    online: () => navigator.onLine,
    downloads: preview ? undefined : (host?.mailDownloads ?? legacy),
    subscribe(reload, offline, reset) {
      window.addEventListener("online", reload);
      window.addEventListener("offline", offline);
      window.addEventListener("matrix-mail-cache-scope-changed", reset);
      return () => {
        window.removeEventListener("online", reload);
        window.removeEventListener("offline", offline);
        window.removeEventListener("matrix-mail-cache-scope-changed", reset);
      };
    },
    async exportContent(content) {
      const url = URL.createObjectURL(
        new Blob([content], { type: "application/json" }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "edition-export.json";
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
  };
}
