export interface CodexSchemaVerification { schemaSha256?: string; schemaSha256ByTarget?: Record<string, string> }
export interface CodexProviderContract {
  latestVerifiedVersion: string;
  verifiedVersions: Record<string, CodexSchemaVerification>;
  requiredEventTypes?: string[];
  requiredServerMethods?: string[];
  requiredServerNotifications?: string[];
  requiredServerProtocolSchemaDigests?: Record<string, string | CodexSchemaVerification>;
  routineProtocolsByVersion?: Record<string, { client: Record<string, string>; definitions: Record<string, string> }>;
}
export function codexProtocolMethodDigest(schema: unknown, definitionName: string, method: string): string;
export function codexProtocolDefinitionDigest(schema: unknown, definition: string): string;
export function verifyCodexProviderContracts(options: { version: string; execContract: CodexProviderContract; appServerContract: CodexProviderContract;
  execSchemaBytes: Buffer; appServerSchemaBytes: Buffer; runtimeTarget?: string }): void;
