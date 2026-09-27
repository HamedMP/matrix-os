export function desktopProviderIdentityKey(identity: {
  status: "loading" | "signed-out" | "signed-in";
  handle: string | null;
  platformHost: string;
  runtimeSlot: string;
  authGeneration: number;
}): string {
  return [
    identity.status,
    identity.handle ?? "none",
    identity.platformHost,
    identity.runtimeSlot,
    identity.authGeneration,
  ].join("|");
}
