import { useEffect, useState } from "react";
import { OrganizationDrivesNavigation, type CollaborationDirectApi } from "@matrix-os/ui";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../../lib/collaboration";
import { useConnection } from "../../../stores/connection";
import { useFilesNavigation } from "../../../stores/files-navigation";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../../stores/tabs";
export function OrganizationDrivesRail({active}: {active: boolean}) {
  const host=useConnection(state => state.platformHost);
  const slot=useConnection(state => state.runtimeSlot);
  const generation=useConnection(state => state.authGeneration);
  const identity = `${host}\0${slot}\0${generation}`;
  const [client,setClient]=useState<{identity: string; api: CollaborationDirectApi | null} | null>(null);
  const api = client?.identity === identity ? client.api : null;
  useEffect(() => {const next=createDesktopCollaborationApi(host); setClient({identity, api: next}); return () => {if (next) releaseDesktopCollaborationApi(next);};},[host,identity]);
  return <OrganizationDrivesNavigation api={api} active={active} onOpen={drive => {useFilesNavigation.getState().navigateDrive(drive.scopeId); useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);}}/>;
}
