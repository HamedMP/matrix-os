export function createCodexCredentialFileProofReader(input: { homePath: string; codexHome?: string; allowApiKey?: boolean }): () => Promise<string | null>;
export type CodexCredentialFileEvidence = { proof: string; identity: string | null };
export function createCodexCredentialFileEvidenceReader(input: { homePath: string; codexHome?: string; allowApiKey?: boolean }): () => Promise<CodexCredentialFileEvidence | null>;
export function codexNativeGenerationSource(input: { principal: { type: string; email?: string; id?: string }; credentialProof?: string | null; credentialIdentity?: string | null }): string;
