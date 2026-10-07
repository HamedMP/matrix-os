import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { AgentRuntimeSettingsSnapshot, AgentRuntimeSource } from "../agent-config/service.js";
import { projectHermesNativeCatalog } from "./hermes-native-catalog.js";

type Catalog = NonNullable<AiProviderSnapshotV3["nativeHarnessCatalog"]>;
export interface NativeObservationReadScope { signal?: AbortSignal; deadline: number; deferRenewal?: boolean }

/** Internal historical evidence for the renewal decision, never live admission. */
export function projectHermesObservationForRenewal(snapshot: AgentRuntimeSettingsSnapshot, now: Date): Catalog {
  const current = projectHermesNativeCatalog(snapshot, now);
  const profiles = [...current.profiles];
  for (const id of ["openai-codex", "openai-api", "anthropic", "openrouter"]) {
    if (profiles.some(profile => profile.providerId === id)) continue;
    const native = snapshot.nativeProfileObservations?.filter(profile => profile.providerId === id) ?? [];
    const observation = snapshot.messaging.provider === id
      ? snapshot.runtime.options.find(runtime => runtime.id === "hermes")?.nativeRouteObservation?.localObservation
      : native.length === 1 ? native[0]?.localObservation : undefined;
    const checked = Date.parse(observation?.checkedAt ?? "");
    const expires = Date.parse(observation?.staleAfter ?? "");
    if (observation?.state !== "present_unverified" || !Number.isFinite(checked) || checked > +now || !(expires <= +now)) continue;
    // Reuse the full native catalog checks at this route's original receipt time.
    // Keep the expired timestamps: this evidence can only trigger a fresh read.
    profiles.push(...projectHermesNativeCatalog(snapshot, new Date(checked)).profiles.filter(profile => profile.providerId === id));
  }
  return { ...current, profiles };
}

/** One fresh read of the same native source, only if other metadata consumed its TTL. */
export async function renewStaleHermesObservation(catalog: Catalog, source: AgentRuntimeSource | undefined,
  now: () => Date, scope: NativeObservationReadScope): Promise<Catalog> {
  scope.signal?.throwIfAborted();
  const stale = catalog.profiles.some(profile => profile.harness === "hermes"
    && profile.localObservation.state === "present_unverified"
    && Date.parse(profile.localObservation.staleAfter ?? "") <= +now());
  if (!stale) return catalog;
  const withoutHermes = { profiles: catalog.profiles.filter(profile => profile.harness !== "hermes"),
    failures: catalog.failures.filter(kind => kind !== "hermes") };
  const remaining = Math.min(6500, scope.deadline - +now());
  if (!source || remaining <= 0) return { ...withoutHermes, failures: [...withoutHermes.failures, "hermes"] };
  const controller = new AbortController();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const abort = () => { controller.abort(scope.signal?.reason); rejectAbort?.(scope.signal?.reason); };
  scope.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    source.invalidate?.();
    const result = await Promise.race([
      new Promise<Catalog>((_, reject) => { rejectAbort = reject; }),
      source(controller.signal).then(snapshot => projectHermesNativeCatalog(snapshot, now())),
      new Promise<Catalog>(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ profiles: [], failures: ["hermes"] });
      }, remaining); }),
    ]);
    scope.signal?.throwIfAborted();
    // Renewal never retries negatives, expands profile capacity or rewrites evidence.
    const hasRoom = withoutHermes.profiles.length + result.profiles.length <= 48;
    return { profiles: [...withoutHermes.profiles, ...(hasRoom ? result.profiles : [])],
      failures: [...withoutHermes.failures, ...(hasRoom ? result.failures : ["hermes" as const])] };
  } catch (error) {
    scope.signal?.throwIfAborted();
    console.warn("[ai-providers] Native observation renewal failed", { errorClass: error instanceof Error ? error.name : "Unknown" });
    return { ...withoutHermes, failures: [...withoutHermes.failures, "hermes"] };
  } finally {
    clearTimeout(timer); controller.abort(); scope.signal?.removeEventListener("abort", abort);
  }
}
