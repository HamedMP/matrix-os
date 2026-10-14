"use client";

import { createContext, useContext, type ReactNode } from "react";

export type OrganizationMembershipStatus = "loading" | "none" | "member" | "unavailable";

export interface OrganizationMembershipState {
  status: OrganizationMembershipStatus;
  organizationId: string | null;
  organizationName?: string | null;
}

const OrganizationStateContext = createContext<OrganizationMembershipState>({
  status: "loading",
  organizationId: null,
  organizationName: null,
});

export function OrganizationStateProvider({ value, children }: {
  value: OrganizationMembershipState;
  children: ReactNode;
}) {
  return <OrganizationStateContext.Provider value={value}>{children}</OrganizationStateContext.Provider>;
}

export function useCollaborationOrganization(): OrganizationMembershipState {
  return useContext(OrganizationStateContext);
}
