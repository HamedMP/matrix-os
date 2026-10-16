// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSection } from "../../shell/src/components/settings/sections/DatabaseSection";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";
// pnpm can give the Web package a different peer-resolved Clerk installation.
vi.mock("../../shell/node_modules/@clerk/nextjs",()=>({useAuth:()=>({userId:"owner",sessionId:"session"})}));
vi.mock("../../shell/src/lib/self-host-mode",()=>({isSelfHostedRuntime:()=>false}));
vi.mock("@matrix-os/ui",async()=>({
  ...await import("../../packages/ui/src/database-access/client"),
  ...await import("../../packages/ui/src/database-access/DatabaseSettings"),
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each(["Web Canvas","Web Desktop"])("%s uses owner API and creates a password-prompting SQL session in its selected runtime",async()=>{
  window.history.replaceState({},"","/vm/owner-machine?runtime=pr-42");
  const snapshot={connection:{host:"127.0.0.1",port:5432,database:"matrix",username:"matrix_owner"},credentialReady:true};
  const fetcher=vi.fn().mockImplementation(async (url:string)=> {
    if(url.endsWith("/api/database")) return Response.json(snapshot);
    if(url.endsWith("/api/database/terminal")) return Response.json({command:"psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W"});
    if(url.endsWith("/ensure")) return Response.json({workspace:{id:`tws_${"a".repeat(32)}`}});
    return Response.json({tab:{id:`tt_${"b".repeat(32)}`}});
  });
  vi.stubGlobal("fetch",fetcher); const open=vi.fn();
  render(<DatabaseSection onOpenTerminal={open}/>);
  await screen.findByText("matrix_owner");
  fireEvent.click(screen.getByRole("button",{name:"Open SQL Terminal"}));
  await waitFor(()=>expect(open).toHaveBeenCalledWith(`tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`));
  expect(fetcher.mock.calls.every(([url])=>url.includes("/vm/owner-machine/~runtime/pr-42/api/"))).toBe(true);
  const tabBody=JSON.parse(fetcher.mock.calls.at(-1)![1].body);
  expect(tabBody.command).toEqual(["sh","-lc","psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W"]);
  expect(fetcher.mock.calls.some(([url])=>url.includes("credentials"))).toBe(false);
  fireEvent.click(screen.getByRole("button", {name:"Export database"}));
  expect(Number(screen.getByRole("alertdialog").style.zIndex)).toBeGreaterThan(SHELL_Z_INDEX.settings);
});
it("renders neutral server markup before choosing hosted authentication",async()=>{
  const {renderToString}=await import("react-dom/server");
  const html=renderToString(<DatabaseSection/>);
  expect(html).toContain("Loading database access");
  expect(html).not.toContain("matrix_owner");
});
