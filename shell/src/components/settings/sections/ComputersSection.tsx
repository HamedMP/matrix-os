"use client";
import { useAuth } from "@clerk/nextjs";
import {
  OwnedComputersPanel,
  ownedComputersAvailability,
  type OwnedComputersTransport,
} from "@matrix-os/ui/owned-computers";
import { useMemo, useSyncExternalStore } from "react";
import { isSelfHostedRuntime, runtimeSubstrate } from "@/lib/self-host-mode";
import { announceComputersChanged } from "@/lib/computers-changed";

const REQUEST_TIMEOUT_MS = 10_000;
const subscribeRuntime = () => () => {};
const serverRuntime = () => null;
const readRuntime = () => ownedComputersAvailability({ selfHosted: isSelfHostedRuntime(), substrate: runtimeSubstrate() })
  + (isSelfHostedRuntime() ? ":self" : ":hosted");

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

/**
 * Same-origin platform transport. Hosted shells add the Clerk bearer; an
 * enrolled owned computer has no Clerk provider and relies on the
 * app.matrix-os.com session cookie that routed this page.
 */
function createOwnedComputersFetchTransport(getBearer: (() => Promise<string | null>) | null): OwnedComputersTransport {
  async function send(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    const bearer = getBearer ? await getBearer() : null;
    if (getBearer && !bearer) throw new Error("Sign in required");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Owned computers request failed");
    }
    return response;
  }
  return {
    async get(path, init) { return (await send(path, { method: "GET", signal: init?.signal })).json(); },
    async patch(path, body) {
      return (await send(path, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json();
    },
    async remove(path) { await (await send(path, { method: "DELETE" })).body?.cancel(); },
  };
}

export function ComputersSection() {
  const runtime = useSyncExternalStore(subscribeRuntime, readRuntime, serverRuntime);
  if (runtime === null) return <SectionFrame><p className="text-sm">Checking connection…</p></SectionFrame>;
  if (runtime.startsWith("hosted-account")) {
    return <SectionFrame><p className="text-sm">Owned computers are managed from your hosted Matrix account.</p></SectionFrame>;
  }
  return runtime.endsWith(":self") ? <EnrolledComputers /> : <ManagedComputers />;
}

function EnrolledComputers() {
  const transport = useMemo(() => createOwnedComputersFetchTransport(null), []);
  return <SectionFrame><OwnedComputersPanel scope="enrolled-owned-computer" transport={transport} onChanged={announceComputersChanged} /></SectionFrame>;
}

function ManagedComputers() {
  const { userId, sessionId, getToken } = useAuth();
  const transport = useMemo(
    () => createOwnedComputersFetchTransport(async () => (userId ? getToken() : null)),
    [userId, getToken],
  );
  return (
    <SectionFrame>
      <OwnedComputersPanel scope={JSON.stringify([userId, sessionId])} transport={transport} onChanged={announceComputersChanged} />
    </SectionFrame>
  );
}
