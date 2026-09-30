"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import {
  OrganizationListingSchema,
  resolveActiveOrganizationId,
  type OrganizationListing,
  type OrganizationMemberships,
} from "@matrix-os/ui";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const LISTING_TIMEOUT_MS = 10_000;
const LISTING_RESPONSE_LIMIT = 64 * 1024;

/**
 * Renders `children` with the organization Share controls act in. Sharing
 * exists only inside an organization (S20 / T101), so every share request
 * carries this identifier and the share controls stay disabled without one.
 * Clerk's active organization wins; without one, the account's only verified
 * membership from the platform listing is used (spec 535 FR-024), the same
 * rule Electron Desktop applies. The E2E bypass shell runs without a
 * ClerkProvider, so it renders without an organization instead of calling
 * Clerk hooks. The subtree is keyed by the organization so a change remounts
 * it: no pending preflight token or open scope can carry over to another one.
 */
export function CollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  if (e2eBypass) return <Fragment key="no-organization">{children(null)}</Fragment>;
  return <ClerkCollaborationOrganization>{children}</ClerkCollaborationOrganization>;
}

function ClerkCollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const { isLoaded, organization } = useOrganization();
  const { userId } = useAuth();
  const origin = useBrowserOrigin();
  const clerkOrganizationId = isLoaded ? organization?.id ?? null : undefined;
  // The platform is asked only when Clerk has loaded and has no active organization.
  const memberships = useOrganizationMemberships(clerkOrganizationId === null && userId && origin ? { userId, origin } : null);
  const organizationId = resolveActiveOrganizationId({ clerkOrganizationId, memberships });
  return <Fragment key={organizationId ?? "no-organization"}>{children(organizationId)}</Fragment>;
}

function useOrganizationMemberships(account: { userId: string; origin: string } | null): OrganizationMemberships {
  const userId = account?.userId ?? null;
  const origin = account?.origin ?? null;
  const [result, setResult] = useState<{ userId: string; memberships: OrganizationMemberships } | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the membership listing is account state Share controls need on mount, not a user event; the bounded request is shared by Share controls mounted together and ignored after unmount.
  useEffect(() => {
    if (!userId || !origin) return;
    let active = true;
    loadOrganizationListing(userId, origin).then((listing) => {
      if (active) setResult({ userId, memberships: { status: "loaded", listing } });
    }, (error: unknown) => {
      console.warn("[collaboration-organization] organization listing unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ userId, memberships: { status: "failed" } });
    });
    return () => {
      active = false;
      // Memberships may change while the fallback is inactive (Clerk has an active
      // organization, or the account changed), so a later activation starts from
      // loading instead of reusing this answer.
      setResult(null);
    };
  }, [userId, origin]);
  return userId && result?.userId === userId ? result.memberships : { status: "loading" };
}

// Share controls mounted together share one request; an entry is only reused
// for the account that started it, and is dropped once it settles.
let inflight: { key: string; promise: Promise<OrganizationListing> } | null = null;

function loadOrganizationListing(userId: string, origin: string): Promise<OrganizationListing> {
  const key = `${userId}\n${origin}`;
  if (inflight?.key === key) return inflight.promise;
  const promise = fetchOrganizationListing(origin).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { key, promise };
  return promise;
}

async function fetchOrganizationListing(origin: string): Promise<OrganizationListing> {
  const response = await fetch(`${origin}/api/organizations`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
    redirect: "error",
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw new Error("OrganizationListingUnavailable");
  }
  return OrganizationListingSchema.parse(JSON.parse(await readBoundedText(response)));
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > LISTING_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("OrganizationListingTooLarge");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
