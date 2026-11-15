import { useMemo } from "react";
import { RoutineActionInbox, createRoutineActionClient } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { desktopRoutineActionRequest, openDesktopRoutineConfirmation } from "../chat/routine-action-confirmation";
export function DesktopRoutineConfirmations() {
  const api = useConnection(state => state.api), generation = useConnection(state => state.authGeneration), runtime = useConnection(state => state.runtimeSlot);
  const client = useMemo(() => api ? createRoutineActionClient(desktopRoutineActionRequest) : null, [api]);
  return client ? <RoutineActionInbox client={client} identity={JSON.stringify([generation, runtime])} openConfirmation={openDesktopRoutineConfirmation}/> : null;
}
