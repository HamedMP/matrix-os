import type { CanonicalChatModelSelection, MatrixOpenAiBinding, MatrixOpenAiConnection } from "@matrix-os/contracts";
import type { ResolvedBotRoute } from "./route-resolver.js";
import type { PiRuntimeBinding } from "./runtime-registry.js";
export type { MatrixOpenAiBinding };
/** Explicit owner API billing. Canonical key custody and all qualification stay in the gateway. */
export interface MatrixOpenAiAuthority {
  observe(ownerId: string): Promise<MatrixOpenAiConnection>;
  resolve(selection: CanonicalChatModelSelection, ownerId: string, requestClass: "interactive" | "background"): Promise<ResolvedBotRoute>;
  revalidate(binding: PiRuntimeBinding, signal: AbortSignal): Promise<boolean>;
  /** Private exact-generation credential read; never a renderer or worker response. */
  credential(binding: PiRuntimeBinding, signal: AbortSignal): Promise<string>;
}
