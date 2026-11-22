"use client";
import { useAuth } from "@clerk/nextjs";
import { OwnedComputersPanel, type OwnedComputersTransport } from "@matrix-os/ui/owned-computers";
import { useMemo, useSyncExternalStore } from "react";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";

const REQUEST_TIMEOUT_MS = 10_000;
const subscribeRuntime = () => () => {};
const serverRuntime = () => null;

function SectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl p-5 sm:p-8">
      <h2 className="hidden text-xl font-semibold md:block">Computers</h2>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">
        Connect your own laptop or server and use it from Matrix like a hosted computer.
      </p>
      {children}
    </div>
  );
}

export function ComputersSection() {
  const selfHosted = useSyncExternalStore(subscribeRuntime, isSelfHostedRuntime, serverRuntime);
  if (selfHosted === null) return <SectionFrame><p className="text-sm">Checking connection…</p></SectionFrame>;
  if (selfHosted) {
    return <SectionFrame><p className="text-sm">Owned computers are managed from your hosted Matrix account.</p></SectionFrame>;
  }
  return <ManagedComputers />;
}

function ManagedComputers() {
  const { userId, sessionId, getToken } = useAuth();
  const transport = useMemo<OwnedComputersTransport>(() => {
    async function send(path: string, init: RequestInit): Promise<Response> {
      if (!userId) throw new Error("Sign in required");
      const token = await getToken();
      if (!token) throw new Error("Sign in required");
      const response = await fetch(path, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Owned computers request failed");
      }
      return response;
    }
    return {
      async get(path) { return (await send(path, { method: "GET" })).json(); },
      async patch(path, body) {
        return (await send(path, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json();
      },
      async remove(path) { await (await send(path, { method: "DELETE" })).body?.cancel(); },
    };
  }, [userId, getToken]);
  return (
    <SectionFrame>
      <OwnedComputersPanel scope={JSON.stringify([userId, sessionId])} transport={transport} />
    </SectionFrame>
  );
}
