/** Trusted server read options, never persisted or accepted from renderer inputs. */
export interface ProviderSnapshotReadOptions {
  refresh?: boolean;
  /** Exact managed Matrix admission skips unrelated native inventory; never cache its authority. */
  admissionScope?: "managed_matrix";
  /** Trusted runtime-owner-only identity/allowance enrichment; never renderer input. */
  includeNativeAccountMetadata?: boolean;
  signal?: AbortSignal;
  /** Recipe-only exact selected key/model; never accepted from renderer input. */
  ownerKeyPreflight?: { modelId: string; credentialFingerprint: string };
  /** Recipe preflight must not pay generic funded probes before identity/catalog gates. */
  suppressFundedProbes?: boolean;
}
