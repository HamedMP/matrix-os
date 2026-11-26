import { hasFreshCodexLocalSignIn, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { NativeAccountCompletionProof } from "./native-account-metadata-binding.js";
import type { ProviderSettingsStoreWriter } from "./provider-settings-store.js";

type CaptureProof = () => Promise<NativeAccountCompletionProof | null>;

/** A fresh native observation can offer verification, while only private proof can bind the account. */
export async function discoverExistingCodexLogin(
  store: ProviderSettingsStoreWriter,
  snapshot: ProviderSettingsSnapshot,
  harnessInstanceId: string,
): Promise<CaptureProof | undefined> {
  if (snapshot.access.mode !== "writable" || !store.captureExistingCodexLoginProof || !store.completeCodexNativeLogin) return;
  const codex = snapshot.harnesses.filter(row => row.harness === "codex");
  const harness = codex.length === 1 ? codex[0] : undefined;
  if (harness?.id !== harnessInstanceId || harness.installState !== "installed"
    || harness.route.kind !== "fixed" || harness.route.providerId !== "openai") return;

  const source = snapshot.accessSources.find(row => row.id === "owner_openai_profile" && row.providerId === "openai"
    && row.kind === "provider_account" && row.fundingKind === "owner_account" && row.accountId === "owner_codex");
  const account = snapshot.accounts.find(row => row.id === "owner_codex" && row.providerId === "openai" && row.accessSourceId === source?.id);
  if (!source || !account || account.authMethod === "api_key" || !source.eligibleModelIds.includes(harness.route.modelId)) return;

  const capture = async () => {
    try { return await store.captureExistingCodexLoginProof!(); }
    catch (error) {
      console.warn("[provider-workflow] Existing Codex account verification unavailable:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
  if (hasFreshCodexLocalSignIn(source, Date.now())) return capture;

  const observedProof = await capture();
  return observedProof ? async () => observedProof : undefined;
}
