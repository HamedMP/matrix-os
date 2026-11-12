"use client";

import {
  CollaborationParticipantSchema,
  type CollaborationParticipant,
} from "@matrix-os/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";

const OwnerCollaborationParticipantContext = createContext<CollaborationParticipant | null>(null);

export function OwnerCollaborationParticipantProvider({ actorId, children }: {
  actorId: string | null | undefined;
  children: ReactNode;
}) {
  const participant = useMemo(() => {
    const parsed = CollaborationParticipantSchema.safeParse({ actorId, displayName: "App owner" });
    return parsed.success ? parsed.data : null;
  }, [actorId]);
  return <OwnerCollaborationParticipantContext.Provider value={participant}>
    {children}
  </OwnerCollaborationParticipantContext.Provider>;
}

export function useOwnerCollaborationParticipant(): CollaborationParticipant | null {
  return useContext(OwnerCollaborationParticipantContext);
}
