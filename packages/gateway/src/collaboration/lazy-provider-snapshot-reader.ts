/**
 * S08: the gateway builds the collaboration runtime before the owner's
 * Provider V3 service exists, so production wiring hands it this lazy
 * reader. Reads fail closed until `attach()` runs once with the real
 * service; the runtime only consults the reader at policy writes and run
 * admission, never during construction.
 */
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";

export interface LazyProviderSnapshotReader {
  reader: CanonicalProviderSnapshotReader;
  /** Binds the live service exactly once; a second attach is a wiring bug. */
  attach(service: CanonicalProviderSnapshotReader): void;
}

export function createLazyProviderSnapshotReader(): LazyProviderSnapshotReader {
  let service: CanonicalProviderSnapshotReader | undefined;
  return {
    reader: {
      getSnapshot: (options) => {
        if (!service) return Promise.reject(new Error("ProviderSnapshotUnavailable"));
        return service.getSnapshot(options);
      },
    },
    attach(next) {
      if (service) throw new Error("Provider snapshot reader already attached");
      service = next;
    },
  };
}
