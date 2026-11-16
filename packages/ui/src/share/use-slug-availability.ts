import { useEffect, useState } from "react";
import { localSlugState, type SlugState } from "./share-model";
import type { ShareSiteClient } from "./share-site-client";

export const SLUG_CHECK_DEBOUNCE_MS = 350;

/**
 * Debounced friendly-path check. Local rules (empty, format, reserved, the
 * owner's current path) answer immediately; everything else asks the platform.
 * A failed check reads as `unknown`, which does not block publishing: the
 * platform's atomic alias claim remains the authority.
 */
export function useSlugAvailability({ client, appSlug, slug, currentSlug, conflict }: {
  client: ShareSiteClient; appSlug: string; slug: string; currentSlug: string | null; conflict: string | null;
}): SlugState {
  const local = localSlugState(slug, currentSlug);
  const [remote, setRemote] = useState<{ slug: string; state: SlugState } | null>(null);
  const answeredLocally = local !== null;
  useEffect(() => {
    if (answeredLocally) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.slugAvailability(appSlug, slug, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        const state: SlugState = result.status === "taken" ? { kind: "taken", suggestions: result.suggestions }
          : result.status === "available" ? { kind: "available" }
          : { kind: result.status };
        setRemote({ slug, state });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[share] friendly path check failed", error instanceof Error ? error.name : "UnknownError");
        setRemote({ slug, state: { kind: "unknown" } });
      });
    }, SLUG_CHECK_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, appSlug, slug, answeredLocally]);
  if (local) return local;
  if (conflict === slug) return { kind: "taken", suggestions: remote?.slug === slug && remote.state.kind === "taken" ? remote.state.suggestions : [] };
  return remote?.slug === slug ? remote.state : { kind: "checking" };
}
