export declare const MAX_CAPTURED_ARTIFACT_BYTES: number;
export declare function readCodexArtifactFile(
  path: string,
  isAllowed: (resolvedPath: string) => Promise<boolean>,
): Promise<Buffer>;
export declare function storeCodexArtifactBytes(input: {
  homePath: string;
  bytes: Buffer;
  label: string;
}): Promise<{ ownerReference: string; sha256: string; sizeBytes: number }>;
export declare function codexArtifactAttachmentId(input: {
  sessionId: string;
  providerItemId: string;
  outputIndex: number;
  sha256: string;
}): string;
