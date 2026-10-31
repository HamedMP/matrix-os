/** Validated values returned by the dependency-free reviewed workflow helpers. */
export function validatePreviewPairBuild(input: unknown, pull: unknown, run: unknown): {
  pr: number; sourceSha: string; pairId: string; generation: number; controllerSha: string;
};
export function createPreviewPairBuildReceipts(input: unknown, pull: unknown, run: unknown, artifacts: unknown): Array<{
  runId: number; artifactId: number; sourceSha: string; workflowSha: string;
  platform: "linux" | "darwin"; arch: "x64" | "arm64"; sha256: string; sizeBytes: number;
}>;
