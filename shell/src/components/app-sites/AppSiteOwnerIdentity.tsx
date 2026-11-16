"use client";

import { createContext, useContext, type ReactNode } from "react";

const AppSiteOwnerIdentityContext = createContext("local-user");

export function AppSiteOwnerIdentityProvider({ children, value }: { children: ReactNode; value: string }) {
  return <AppSiteOwnerIdentityContext value={value}>{children}</AppSiteOwnerIdentityContext>;
}

export function useAppSiteOwnerIdentity(): string {
  return useContext(AppSiteOwnerIdentityContext);
}
