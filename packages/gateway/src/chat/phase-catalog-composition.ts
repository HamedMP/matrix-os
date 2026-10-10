import { projectMatrixAnthropicProviderInstances } from "../bots/matrix-anthropic-provider-instance.js";
import { projectChatGptPlanProviderInstances } from "../bots/chatgpt-plan-provider-instance.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";

/** A canonical server phase projects the base catalog without observing other
 * account authorities. The base scope revalidates identity/window on every read. */
export function composePhaseCatalog(base: ChatProviderCatalogService, canonical: boolean,
  decorate: (catalog: ChatProviderCatalogService) => Pick<ChatProviderCatalogService, "getCatalog">): ChatProviderCatalogService {
  if (canonical) {
    const project = (catalog: Awaited<ReturnType<typeof base.getCatalog>>) => projectChatGptPlanProviderInstances(projectMatrixAnthropicProviderInstances(catalog, undefined, false), undefined, false);
    return { getCatalog: async (principal, selection, readOptions) => project(await base.getCatalog(principal, selection, readOptions)),
      refresh: async (principal, readOptions) => project(await base.refresh(principal, readOptions)) };
  }
  const enhanced = decorate(base);
  return { ...base, getCatalog: enhanced.getCatalog,
    refresh: async (principal, readOptions) => { await base.refresh(principal, readOptions); return enhanced.getCatalog(principal); } };
}
