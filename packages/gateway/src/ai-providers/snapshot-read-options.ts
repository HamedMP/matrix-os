/** Trusted server read options, never persisted or accepted from renderer inputs. */
export interface ProviderSnapshotReadOptions {
  refresh?: boolean;
  /** Exact managed Matrix admission skips unrelated native inventory; never cache its authority. */
  admissionScope?: "managed_matrix" | "canonical_matrix";
  /** Trusted runtime-owner-only identity/allowance enrichment; never renderer input. */
  includeNativeAccountMetadata?: boolean;
  /** Foreground login completion verifies identity independently of quota. */
  includeNativeAccountUsage?: boolean;
  signal?: AbortSignal;
  /** Original server request deadline (epoch ms), including Settings queue time; cannot extend renewal budgets. */
  nativeObservationDeadline?: number;
  /** Recipe-only exact selected key/model; never accepted from renderer input. */
  ownerKeyPreflight?: { modelId: string; credentialFingerprint: string };
  /** Recipe preflight must not pay generic funded probes before identity/catalog gates. */
  suppressFundedProbes?: boolean;
}
