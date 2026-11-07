import { useCallback, useMemo } from "react";
import { GithubDeveloperAccessCard, type GithubDeveloperAccessClient } from "@matrix-os/ui";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import {
  createDesktopProviderSettingsTransport,
  openDesktopGithubDeveloperSetup,
} from "../settings/provider-settings-desktop-adapter";

export function GithubDeveloperIntegration({ active }: { active: boolean }) {
  const signedIn = useConnection((state) => state.status === "signed-in");
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const identityKey = useConnection(desktopProviderIdentityKey);
  const runtimeApi = useMemo(() => api?.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const isIdentityCurrent = useCallback(
    () => desktopProviderIdentityKey(useConnection.getState()) === identityKey,
    [identityKey],
  );
  const client = useMemo<GithubDeveloperAccessClient | null>(() => runtimeApi ? ({
    async status(signal: AbortSignal) {
      const value = await runtimeApi.get<unknown>("/api/github/status", {
        maxBytes: 16 * 1024,
        timeoutMs: 10_000,
        signal,
        cache: "no-store",
        omitErrorBody: true,
      });
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      return value;
    },
    async setupAccess(signal) {
      const { access } = await createDesktopProviderSettingsTransport(runtimeApi).getSnapshot(signal);
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      return access;
    },
    startSetup: () => openDesktopGithubDeveloperSetup(runtimeApi, isIdentityCurrent),
  }) : null, [isIdentityCurrent, runtimeApi]);
  return signedIn && client ? <GithubDeveloperAccessCard identityKey={identityKey} client={client} active={active} /> : null;
}
