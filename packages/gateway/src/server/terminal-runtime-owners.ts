/** Shared trusted runtime-owner policy for Terminal and native Coding execution. */
export function resolveTerminalRuntimeOwners(ownerId: string | undefined, nodeEnv: string | undefined): string[] {
  return ownerId ? [ownerId] : nodeEnv === "production" ? [] : ["default"];
}
