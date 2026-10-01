// @vitest-environment jsdom
import React from "react";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
const {api,loadOptions}=vi.hoisted(()=>({api:{get:vi.fn(),direct:{close:vi.fn(),request:vi.fn()},subscribe:vi.fn(()=>vi.fn())},loadOptions:vi.fn()}));
vi.mock("@matrix-os/ui",async original=>({...await original<object>(),loadOrganizationDriveOptions:loadOptions}));
vi.mock("../../desktop/src/renderer/src/lib/collaboration",()=>({createDesktopCollaborationApi:()=>api,releaseDesktopCollaborationApi:vi.fn()}));
vi.mock("../../shell/src/lib/collaboration",()=>({createShellCollaborationApi:()=>api}));
vi.mock("../../shell/src/hooks/useBrowserOrigin",()=>({useBrowserOrigin:()=>"http://localhost:3000"}));
import {DesktopOrganizationDrivesView} from "../../desktop/src/renderer/src/features/files/DesktopOrganizationDrivesView";
import {OrganizationDrivesView} from "../../shell/src/components/file-browser/OrganizationDrivesView";
const option=(scopeId:string)=>({scopeId,organizationId:"org_example",name:scopeId,state:"ready",canManage:false,canUpload:false,pages:1,snapshot:{organizationId:"org_example",scopeId,usedBytes:0,reservedBytes:0,quotaBytes:1e12,files:[]}});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe("drive subscription follows the displayed drive",()=>{
 it.each(["Web","Electron"])("subscribes to the replacement drive on %s after removal",async surface=>{
  loadOptions.mockResolvedValue([option("first"),option("second")]);render(surface==="Web"?<OrganizationDrivesView/>:<DesktopOrganizationDrivesView/>);
  await waitFor(()=>expect(api.subscribe).toHaveBeenLastCalledWith("first",expect.any(Function),expect.any(Function)));
  loadOptions.mockResolvedValue([option("second")]);fireEvent.click(screen.getByRole("button",{name:"Refresh"}));
  await waitFor(()=>expect(api.subscribe).toHaveBeenLastCalledWith("second",expect.any(Function),expect.any(Function)));
 });
});
