import { createHash } from 'node:crypto';
import { runConfinedFileAgent } from '@matrix-os/kernel';
import type { AiProviderSnapshotV3, AppAiRouteSelection } from '@matrix-os/contracts';
import { projectAppAiAuthorizationRoutes, sameAppAiRoute } from '../app-ai/connected-routes.js';
import { generateApiAppText } from '../app-ai/api-completion.js';
import { resolveBotRoute, BotRouteError } from '../bots/route-resolver.js';
import { buildKernelCredentialLaunch, resolveKernelCredentialSources } from '../kernel-credentials.js';
import type { MatrixFundedCredentialProvider } from '../funded-ai-credential-manager.js';
import type { FundedAdmissionQueue } from '../funded-ai/admission-queue.js';
import type { ProviderSnapshotReadOptions } from '../ai-providers/snapshot-read-options.js';
import { StoreError } from './platform-client.js';

export interface StoreGeneralizerOptions {
  providerSnapshotReader?: { getSnapshot(options?: ProviderSnapshotReadOptions): Promise<AiProviderSnapshotV3> };
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  fetchImpl?: typeof fetch;
}
export interface StoreGeneralizerStatus { available: boolean; label: string; accessSourceId: string }
export interface StoreGeneralizerSelection { status: StoreGeneralizerStatus; route?: AppAiRouteSelection }

/** Trusted owner publishing capability. This never enables app AI or exposes credentials to submitted code. */
export function createStoreGeneralizationProvider(homePath: string, options: StoreGeneralizerOptions) {
  async function select(signal: AbortSignal): Promise<StoreGeneralizerSelection> {
    signal.throwIfAborted();
    if (options.providerSnapshotReader && options.fundedCredentialProvider?.enabled && options.fundedAdmission) {
      const canonical = await options.providerSnapshotReader.getSnapshot({
        admissionScope: 'canonical_matrix', includeNativeAccountMetadata: false, includeNativeAccountUsage: false, signal,
      });
      signal.throwIfAborted();
      let resolved: ReturnType<typeof resolveBotRoute> | undefined;
      try { resolved = resolveBotRoute(canonical); }
      catch (error: unknown) { if (!(error instanceof BotRouteError)) throw error; }
      if (resolved?.accessSourceId === 'matrix_included') {
        // Resolve the exact underlying source; the shared bot resolver uses one funded credential kind.
        const accessSourceId = resolved.route.api === 'anthropic-messages' ? 'matrix_included' : 'matrix_cloudflare';
        const route: AppAiRouteSelection = { harnessId: 'matrix_ai', accountId: null, accessSourceId, modelId: resolved.route.modelId };
        const model = canonical.models.find(entry => entry.id === route.modelId);
        const source = canonical.accessSources.find(entry => entry.id === accessSourceId);
        const eligible = projectAppAiAuthorizationRoutes(undefined, canonical).routes.some(entry => entry.availability === 'available' && sameAppAiRoute(entry, route));
        if (eligible && model && source?.vendor === model.vendor && source.fundingKind === 'matrix_included') {
          const digest = createHash('sha256').update(JSON.stringify(route)).digest('hex').slice(0, 32);
          const vendor = accessSourceId === 'matrix_cloudflare' ? 'Cloudflare' : 'Anthropic';
          return { route, status: { available: true, label: `Matrix AI Gateway · ${vendor} · ${model.displayName}`.slice(0, 120), accessSourceId: `${accessSourceId}_${digest}` } };
        }
      }
    }
    // A different disclosed source requires fresh consent. A running Matrix job never takes this fallback.
    const sources = await resolveKernelCredentialSources(homePath, {});
    return { status: { available: sources.ownerApiKey.state === 'ready' || sources.ownerApiKey.state === 'unverified', label: 'Anthropic (your API key; Haiku 4.5)', accessSourceId: 'owner_anthropic_key' } };
  }
  async function connect(selection: StoreGeneralizerSelection, signal: AbortSignal) {
    if (selection.route) {
      const revalidate = async () => {
        const current = await select(signal);
        return current.status.available && current.status.accessSourceId === selection.status.accessSourceId
          && current.route !== undefined && sameAppAiRoute(current.route, selection.route!);
      };
      return async (prompt: string): Promise<unknown> => {
        // Check before a lease and again in the shared API helper after lease/queue waits and response.
        if (!await revalidate()) throw new StoreError('conflict');
        const response = await generateApiAppText({ ...options, homePath, route: selection.route!, prompt, signal, revalidate });
        return JSON.parse(response.text) as unknown;
      };
    }
    const launch = await buildKernelCredentialLaunch(homePath, {}, 'owner_anthropic_key', undefined, { requestClass: 'interactive' });
    const env = { PATH: process.env.PATH, ANTHROPIC_API_KEY: launch.env?.ANTHROPIC_API_KEY };
    return (prompt: string) => runConfinedFileAgent({ prompt, env, signal });
  }
  return { select, connect, async status() { return (await select(AbortSignal.timeout(10_000))).status; } };
}
