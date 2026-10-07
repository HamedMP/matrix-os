import { create } from "zustand";
import { z } from "zod/v4";
export const useOrganizationDriveNavigation = create<{
  request: {scopeId: string; identity: string; id: string} | null;
  open(scopeId: string, identity: string): void;
  consume(request: {scopeId: string; identity: string; id: string}): void;
}>((set) => ({request: null, open: (scopeId, identity) => set({request: {scopeId: z.uuid().parse(scopeId), identity, id: crypto.randomUUID()}}), consume: request => set(state => state.request === request ? {request: null} : {})}));
export function organizationDriveNavigationIdentity(userId: string | null | undefined, sessionId: string | null | undefined, gateway: string): string {
  return `${userId ?? ""}\0${sessionId ?? ""}\0${gateway}`;
}
