export function createCodexCredentialFileProofReader(input: { homePath: string; codexHome?: string; allowApiKey?: boolean }): () => Promise<string | null>;
