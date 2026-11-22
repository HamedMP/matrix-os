"use client";
import { WhatsAppSettingsPanel } from "@matrix-os/ui";
import { ChatAppsPanel, type MessagingBridgeFetch } from "@matrix-os/ui/messaging";
import { useAuth } from "@clerk/nextjs";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { useSocket } from "@/hooks/useSocket";
import { WHATSAPP_SETTINGS_PATH } from "@matrix-os/contracts";
import { useSyncExternalStore } from "react";
const subscribeRuntime = () => () => {};
const serverRuntime = () => null;
const platformOrigin = process.env.NEXT_PUBLIC_MATRIX_APP_URL;
const allowDevelopmentOrigin = process.env.NODE_ENV === "development";
const signInRequired = () =>
  new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in required" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
/** `mobile` hides Your chat apps: Web Mobile is out of scope for spec 2701 phase 0. */
export function MessagingSection({ mobile = false }: { mobile?: boolean }) {
  const selfHosted = useSyncExternalStore(subscribeRuntime, isSelfHostedRuntime, serverRuntime);
  if (selfHosted === null) return <MessagingContent><p>Checking connection…</p></MessagingContent>;
  return selfHosted ? (
    <MessagingContent>
      <p>
        WhatsApp connection settings are available in your hosted Matrix
        account.
      </p>
    </MessagingContent>
  ) : (
    <ManagedMessaging mobile={mobile} />
  );
}
function MessagingContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl p-5 sm:p-8">
      <h2 className="hidden text-xl font-semibold md:block">Messaging</h2>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">
        Your own Matrix, in the apps you already use.
      </p>
      {children}
    </div>
  );
}
function ManagedMessaging({ mobile }: { mobile: boolean }) {
  const { userId, sessionId, getToken } = useAuth();
  const { subscribe, connected } = useSocket();
  const scope = JSON.stringify([userId, sessionId]);
  const bridgeFetch: MessagingBridgeFetch = async (path, init) => {
    if (!userId) return signInRequired();
    const token = await getToken();
    if (!token) return signInRequired();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) });
  };
  return (
    <MessagingContent>
      <WhatsAppSettingsPanel
        platformOrigin={platformOrigin}
        allowDevelopmentOrigin={allowDevelopmentOrigin}
        scope={scope}
        load={async () => {
          if (!userId) throw new Error("Sign in required");
          const token = await getToken();
          if (!token) throw new Error("Sign in required");
          const res = await fetch(WHATSAPP_SETTINGS_PATH, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10000),
            redirect: "error",
            cache: "no-store",
          });
          if (!res.ok) throw new Error("Connection unavailable");
          return res.json();
        }}
      />
      {mobile ? null : <ChatAppsPanel scope={scope} fetch={bridgeFetch} subscribe={subscribe} connected={connected} />}
    </MessagingContent>
  );
}
