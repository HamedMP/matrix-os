import { createClaudeNativeCredentialReader } from "../ai-providers/claude-native-credential.js";

export type ResolveClaudeOwnerIdentity = (signal: AbortSignal) => Promise<{ authorization: string } | null>;

/** No credential leaves the owner gateway; the sandbox only gets inference output. */
export function createClaudeOwnerIdentityResolver(homePath: string): ResolveClaudeOwnerIdentity {
  const read = createClaudeNativeCredentialReader({ homePath, scope: "user:inference" });
  return async signal => {
    signal.throwIfAborted();
    const credential = await read();
    signal.throwIfAborted();
    if (!credential || !/^[^\r\n]+$/.test(credential.token)) return null;
    return { authorization: `Bearer ${credential.token}` };
  };
}
