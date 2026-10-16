// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DatabaseAdapter from "../../desktop/src/renderer/src/features/settings/DatabaseAdapter";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
const mocks = vi.hoisted(()=>({state:{} as Record<string,unknown>,openTab:vi.fn(()=>"terminal-tab"),request:vi.fn(),adopt:vi.fn(),activate:vi.fn()}));
vi.mock("@matrix-os/ui",async()=>({...await import("../../packages/ui/src/database-access/client"),...await import("../../packages/ui/src/database-access/DatabaseSettings")}));
vi.mock("../../desktop/src/renderer/src/stores/connection",()=>({useConnection:Object.assign((selector:(s:unknown)=>unknown)=>selector(mocks.state),{getState:()=>mocks.state})}));
vi.mock("../../desktop/src/renderer/src/stores/tabs",()=>({useTabs:{getState:()=>({openTab:mocks.openTab,requestTerminalSession:mocks.request})}}));
vi.mock("../../desktop/src/renderer/src/stores/shell-sessions",()=>({useShellSessions:{getState:()=>({adoptCreatedSession:mocks.adopt})}}));
vi.mock("../../desktop/src/renderer/src/stores/desktop-surfaces",()=>({useDesktopSurfaces:{getState:()=>({activateSurface:mocks.activate})}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("Electron Desktop uses the shared owner panel and runtime-pinned SQL session",async()=>{
  const fetchFn=vi.fn().mockImplementation(async (url:string)=> {
    if(url.includes("/api/database?")) return Response.json({connection:{host:"127.0.0.1",port:5432,database:"matrix",username:"matrix_owner"},credentialReady:true});
    if(url.includes("/api/database/terminal?")) return Response.json({command:"psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W"});
    if(url.includes("/ensure?")) return Response.json({workspace:{id:`tws_${"a".repeat(32)}`}});
    return Response.json({tab:{id:`tt_${"b".repeat(32)}`}});
  });
  mocks.state={status:"signed-in",handle:"owner",userId:"owner",platformHost:"https://app.example",runtimeSlot:"pr-42",authGeneration:1,api:createApiClient({baseUrl:"https://app.example",getRuntimeSlot:()=>"primary",fetchFn})};
  render(<DatabaseAdapter/>); await screen.findByText("matrix_owner");
  fireEvent.click(screen.getByRole("button",{name:"Open SQL Terminal"}));
  await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith(`tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`));
  expect(fetchFn.mock.calls.every(([url])=>url.includes("runtime=pr-42"))).toBe(true);
  expect(mocks.activate).toHaveBeenCalledWith("terminal-tab");
  expect(mocks.adopt).toHaveBeenCalledOnce();
});
