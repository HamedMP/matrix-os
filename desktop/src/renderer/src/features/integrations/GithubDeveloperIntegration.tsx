import { useCallback, useMemo, type ReactNode } from "react";
import { GITHUB_DEVELOPER_DEVICE_URL, GithubDeveloperAccess, type GithubDeveloperAccessClient, type IntegrationRowPresentation } from "@matrix-os/ui";
import { invoke } from "../../lib/operator";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import {
  createDesktopProviderSettingsTransport,
  openDesktopGithubDeveloperDisconnect,
} from "../settings/provider-settings-desktop-adapter";

export function GithubDeveloperIntegration({ active, children }: {
  active: boolean;
  children: (presentation?: IntegrationRowPresentation) => ReactNode;
}) {
  const signedIn = useConnection((state) => state.status === "signed-in");
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const identityKey = useConnection(desktopProviderIdentityKey);
  const runtimeApi = useMemo(() => api?.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const isIdentityCurrent = useCallback(
    () => desktopProviderIdentityKey(useConnection.getState()) === identityKey,
    [identityKey],
  );
  const client = useMemo<GithubDeveloperAccessClient | null>(() => {
    if (!runtimeApi) return null;
    const request = async (path: string, signal: AbortSignal, post = false) => {
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      const options = { maxBytes: 16 * 1024, timeoutMs: 10_000, signal, cache: "no-store" as const, omitErrorBody: true };
      const url = `/api/github/${path}`;
      const value = post ? await runtimeApi.post<unknown>(url, {}, options) : await runtimeApi.get<unknown>(url, options);
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      return value;
    };
    return {
      status: (signal) => request("status", signal),
      async setupAccess(signal) {
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        const { access } = await createDesktopProviderSettingsTransport(runtimeApi).getSnapshot(signal);
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        return access;
      },
      startSetup: (signal) => request("setup", signal, true),
      getSetup: (id, signal) => request(`setup/${encodeURIComponent(id)}`, signal),
      cancelSetup: (id, signal) => isIdentityCurrent()
        ? request(`setup/${encodeURIComponent(id)}/cancel`, signal, true)
        : Promise.resolve(),
      openSetupPage() {
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        return invoke("shell:open-external", { url: GITHUB_DEVELOPER_DEVICE_URL });
      },
      startDisconnect: (account, signal) => openDesktopGithubDeveloperDisconnect(runtimeApi, account, isIdentityCurrent, signal),
    };
  }, [isIdentityCurrent, runtimeApi]);
  return signedIn && client
    ? <GithubDeveloperAccess identityKey={identityKey} client={client} active={active}>{children}</GithubDeveloperAccess>
    : children();
}
