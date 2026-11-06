"use client";

import { createContext, useContext, type ReactNode } from "react";

const NativeCollaborationActorContext = createContext<string | null>(null);

export function NativeCollaborationActorProvider({ actorId, children }: {
  actorId: string | null;
  children: ReactNode;
}) {
  return <NativeCollaborationActorContext.Provider value={actorId}>
    {children}
  </NativeCollaborationActorContext.Provider>;
}

export function useNativeCollaborationActor(): string | null {
  return useContext(NativeCollaborationActorContext);
}
