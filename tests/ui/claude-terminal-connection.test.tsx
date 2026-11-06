// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {act,cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {ProviderSettingsSnapshotSchema} from "@matrix-os/contracts";
import {AgentsProvidersView} from "../../packages/ui/src/agents-providers/AgentsProvidersView.js";
import nativeInput from "../fixtures/claude-native-authenticated-off.json";
afterEach(cleanup);
it.each(["legacy_profile", "owner_matrix", "saved_key"])("recognizes Terminal native authentication independently of %s without changing execution intent", async shape => {
 const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));
 const native=snapshot.accounts[0]!;snapshot.refreshedAt=new Date().toISOString();native.lastCheckedAt=snapshot.refreshedAt;
 const row=snapshot.harnesses[0]!;
 row.id="harness_kernel";row.authState="unknown";row.enabled=false;row.configuredEnabled=false;
 row.enablementOrigin="owner_configuration";
 if(shape==="owner_matrix") {row.accessSourceId=null;row.selectedAccountId=null;row.configuredAccessSourceId="matrix_included";}
 else {
  const id=shape==="saved_key"?"saved_key":"owner_anthropic_profile";
  const account={...native,id:"other_account",accessSourceId:id,displayName:"Other saved account",authState:"unknown" as const,authMethod:shape==="saved_key"?"api_key" as const:"terminal" as const};
  snapshot.accounts.push(account);row.accountIds.push(account.id);
  snapshot.accessSources.push({...snapshot.accessSources[0]!,id,accountId:account.id,fundingKind:shape==="saved_key"?"owner_api_key":"owner_account"});
  row.accessSourceId=id;row.configuredAccessSourceId=id;row.selectedAccountId=account.id;
 }
 const before=structuredClone(snapshot),onMutate=vi.fn();
 render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={row.id} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={onMutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()}/>);
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:/^Claude/}));});
 fireEvent.click(screen.getByText("Advanced configuration",{selector:"summary"}));
 expect(screen.getByRole("button",{name:/^Claude.*Connected/})).toBeVisible();
 const nativeCard=screen.getByTestId("account-owner_claude_profile");
 expect(within(nativeCard).getByText("Connected · Terminal")).toBeVisible();
 if(shape!=="owner_matrix")expect(within(screen.getByTestId("account-other_account")).getByText(/Not connected/)).toBeVisible();
 expect(snapshot).toEqual(before);expect(onMutate).not.toHaveBeenCalled();
});
it("updates the existing indicator without adding a discovered-account card or changing guided controls",async()=>{
 const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));const account=snapshot.accounts[0]!;
 snapshot.refreshedAt=new Date().toISOString();account.lastCheckedAt=snapshot.refreshedAt;account.connectionDetails={email:"terminal@example.test"};
 const row=snapshot.harnesses[0]!;row.id="harness_kernel";row.authState="unknown";row.accessSourceId=null;row.selectedAccountId=null;row.enablementOrigin="owner_configuration";
 const capabilities=vi.fn(async()=>[{harnessInstanceId:row.id,harness:"claude" as const,displayName:"Claude Code",installState:"installed" as const,loginMethods:["browser" as const],apiKeyProviders:[],install:false,uninstall:false,logs:false,
  connectionOptions:[{id:"native",providerId:"anthropic",authKind:"subscription" as const,method:"browser" as const,billingKind:"subscription" as const,executionKind:"native" as const,availability:"available" as const}]}]);
 const startConnection=vi.fn(),client={capabilities,startConnection,start:vi.fn(),get:vi.fn(),cancel:vi.fn(),submitKey:vi.fn(),logs:vi.fn()};
 render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={row.id} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} workflowClient={client}/>);
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:/^Claude/}));});
 expect(screen.queryByText("terminal@example.test",{exact:true})).not.toBeInTheDocument();
 expect(document.querySelector(".matrix-ap-connected")).toBeNull();
 expect(screen.queryByRole("button",{name:"Use connected Claude account"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:/^Claude.*Connected/})).toBeVisible();expect(screen.getByRole("button",{name:/^Claude account/})).toBeEnabled();expect(startConnection).not.toHaveBeenCalled();
});
it("expires selected native authentication without falling back to an old Connected harness label",async()=>{
 vi.useFakeTimers();try{
  vi.setSystemTime("2026-11-06T10:00:00Z");const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));snapshot.refreshedAt=new Date().toISOString();snapshot.accounts[0]!.lastCheckedAt=snapshot.refreshedAt;
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={snapshot.harnesses[0]!.id} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()}/>);
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:/^Claude/}));});expect(screen.getByRole("button",{name:/^Claude.*Connected/})).toBeVisible();
  await act(async()=>vi.advanceTimersByTimeAsync(30_001));expect(screen.getByRole("button",{name:/^Claude.*Not connected/})).toBeVisible();
 }finally{cleanup();vi.useRealTimers();}
});
it.each([-2650,2650])("uses bounded server-relative native freshness with renderer offset %s and still expires after a wall-clock rollback",async offset=>{
 vi.useFakeTimers();try{
  const server=Date.parse("2026-11-06T10:00:00Z");vi.setSystemTime(server+offset);
  const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));
  snapshot.refreshedAt=new Date(server).toISOString();snapshot.accounts[0]!.lastCheckedAt=snapshot.refreshedAt;
  const props={snapshot,selectedHarnessId:snapshot.harnesses[0]!.id,onSelectHarness:vi.fn(),onRefresh:vi.fn(),onMutate:vi.fn(),onOpenTerminal:vi.fn(),onOpenBrowser:vi.fn()};
  const view=render(<AgentsProvidersView {...props}/>);
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:/^Claude/}));});
  fireEvent.click(screen.getByText("Advanced configuration",{selector:"summary"}));
  expect(screen.getByRole("button",{name:/^Claude.*Connected/})).toBeVisible();
  expect(within(screen.getByTestId("account-owner_claude_profile")).getByText("Connected · Terminal")).toBeVisible();
  await act(async()=>vi.advanceTimersByTimeAsync(15_000));
  view.rerender(<AgentsProvidersView {...props} snapshot={structuredClone(snapshot)}/>);
  vi.setSystemTime(server-86_400_000);
  await act(async()=>vi.advanceTimersByTimeAsync(15_001));
  expect(screen.getByRole("button",{name:/^Claude.*Not connected/})).toBeVisible();
  expect(within(screen.getByTestId("account-owner_claude_profile")).getByText(/Not connected/)).toBeVisible();
 }finally{cleanup();vi.useRealTimers();}
});
it.each(["checked_after_snapshot","excessive_clock_skew","expired_proof"])("rejects %s for native authentication",async scenario=>{
 vi.useFakeTimers();try{
  const server=Date.parse("2026-11-06T10:00:00Z");vi.setSystemTime(server+(scenario==="excessive_clock_skew"?60_001:0));
  const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));snapshot.refreshedAt=new Date(server).toISOString();
  snapshot.accounts[0]!.lastCheckedAt=new Date(server+(scenario==="checked_after_snapshot"?1:scenario==="expired_proof"?-30_001:0)).toISOString();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={snapshot.harnesses[0]!.id} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()}/>);
  await act(async()=>vi.advanceTimersByTimeAsync(100));
  expect(screen.getByRole("button",{name:/^Claude.*Not connected/})).toBeVisible();
 }finally{cleanup();vi.useRealTimers();}
});
it("does not resurrect native proof from a snapshot older than an already accepted stamp",async()=>{
 vi.useFakeTimers();try{
  const server=Date.parse("2026-11-06T10:00:00Z");vi.setSystemTime(server);
  const snapshot=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));snapshot.refreshedAt=new Date(server).toISOString();snapshot.accounts[0]!.lastCheckedAt=snapshot.refreshedAt;
  const props={snapshot,selectedHarnessId:snapshot.harnesses[0]!.id,onSelectHarness:vi.fn(),onRefresh:vi.fn(),onMutate:vi.fn(),onOpenTerminal:vi.fn(),onOpenBrowser:vi.fn()};
  const view=render(<AgentsProvidersView {...props}/>);expect(screen.getByRole("button",{name:/^Claude.*Connected/})).toBeVisible();
  await act(async()=>vi.advanceTimersByTimeAsync(1000));const older=structuredClone(snapshot);older.refreshedAt=new Date(server-1).toISOString();older.accounts[0]!.lastCheckedAt=older.refreshedAt;
  view.rerender(<AgentsProvidersView {...props} snapshot={older}/>);
  expect(screen.getByRole("button",{name:/^Claude.*Not connected/})).toBeVisible();
 }finally{cleanup();vi.useRealTimers();}
});
