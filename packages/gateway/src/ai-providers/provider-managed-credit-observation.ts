import { ProviderManagedCreditObservationSchema, FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiRuntimeChatFundingSummaryResponseSchema, FundedAiChatAvailabilitySchema, type ProviderManagedCreditObservation } from "@matrix-os/contracts";
import type { FundedAiFundingSummaryReader } from "../funded-ai-funding-summary-client.js";
import { readSavedProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import { projectManagedCreditUsage } from "./provider-managed-credit-usage.js";

/** Bound the whole read even when an injected reader ignores cancellation. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}
export async function readManagedCreditObservation(options: {
  configurationPath: string;
  fundingSummaryReader?: FundedAiFundingSummaryReader;
  now: () => Date;
  signal?: AbortSignal;
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  generation: () => number;
}): Promise<ProviderManagedCreditObservation> {
  if (!options.fundingSummaryReader) throw new ProviderSettingsStoreError("projection_unavailable", 503);
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  const readSaved = async () => {
    try { return await readSavedProviderSettingsConfiguration(options.configurationPath); }
    catch (error) {
      console.warn("[provider-settings] Saved configuration unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new ProviderSettingsStoreError("configuration_unavailable", 503);
    }
  };
  const operation = async () => {
    const captured = await options.serialize(async () => {
      signal.throwIfAborted(); const config = await readSaved();
      if (!config) throw new ProviderSettingsStoreError("configuration_unavailable", 503);
      return { generation: options.generation(), revision: config.revision, sourceId: config.gatewayPolicy?.accessSourceId ?? null };
    });
    signal.throwIfAborted();
    const raw = await options.fundingSummaryReader!.getFundingSummary({ signal });
    signal.throwIfAborted();
    const summary = raw.chatAvailability === undefined
      ? FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw })
      : FundedAiRuntimeChatFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw });
    const observation = ProviderManagedCreditObservationSchema.parse({ contractVersion: 1, revision: captured.revision,
      gatewayPolicyAccessSourceId: captured.sourceId,
      usage: projectManagedCreditUsage(summary.funding, "chatAvailability" in summary ? FundedAiChatAvailabilitySchema.parse(summary.chatAvailability) : undefined, options.now()),
      policy: summary.policy, topUpEnabled: summary.funding.topUpEnabled === true });
    const accepted = await options.serialize(async () => {
      signal.throwIfAborted(); const saved = await readSaved();
      return captured.generation === options.generation() && saved?.revision === captured.revision
        && (saved.gatewayPolicy?.accessSourceId ?? null) === captured.sourceId;
    });
    if (!accepted) throw new ProviderSettingsStoreError("projection_unavailable", 503);
    return observation;
  };
  try { return await bounded(operation(), signal); }
  catch (error) {
    if (error instanceof ProviderSettingsStoreError) throw error;
    console.warn("[provider-settings] Managed credit observation unavailable:", error instanceof Error ? error.name : "UnknownError");
    throw new ProviderSettingsStoreError("projection_unavailable", 503);
  }
}
