"use client";
import { SlackInstallPanel, WhatsAppSettingsPanel } from "@matrix-os/ui";
import { useAuth } from "@clerk/nextjs";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { WHATSAPP_SETTINGS_PATH } from "@matrix-os/contracts";
import { useSyncExternalStore } from "react";
const subscribeRuntime = () => () => {};
const serverRuntime = () => null;
export function MessagingSection() {
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
    <ManagedMessaging />
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
      <SlackInstallPanel showHeading={false} />
    </div>
  );
}
function ManagedMessaging() {
  const { userId, sessionId, getToken } = useAuth();
  return (
    <MessagingContent>
      <WhatsAppSettingsPanel
        scope={JSON.stringify([userId, sessionId])}
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
    </MessagingContent>
  );
}
