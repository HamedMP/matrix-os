import { EditionDownloads } from "./offline";
import type { EditionDownloadHost } from "./runtime";
/** One bounded in-memory snapshot; persistence is provided only by the trusted host. */
export async function loadDeviceDownloads(host: EditionDownloadHost) {
  const loaded = await host.load();
  let raw = loaded.raw;
  let persisted = loaded.raw;
  const cache = new EditionDownloads(
    {
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value;
      },
      removeItem: () => {
        raw = null;
      },
    },
    loaded.scope,
  );
  cache.list(); // Validate before exposing persisted contents.
  return {
    cache,
    save: async () => {
      const candidate = raw;
      try {
        if (candidate === null) await host.clear();
        else await host.save(candidate);
        persisted = candidate;
      } catch (cause) {
        if (raw === candidate) raw = persisted;
        throw cause;
      }
    },
    clear: () => host.clear(),
  };
}
