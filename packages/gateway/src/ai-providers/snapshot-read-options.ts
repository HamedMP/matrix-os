/** Trusted server read options, never persisted or accepted from renderer inputs. */
export interface ProviderSnapshotReadOptions {
  refresh?: boolean;
  /** Recipe preflight must not pay generic funded probes before identity/catalog gates. */
  suppressFundedProbes?: boolean;
}
