import {beforeEach,describe,expect,it} from "vitest";
import {resolveOrganizationDriveNavigation} from "../../packages/ui/src/organization-drive/paging";
import {useOrganizationDriveNavigation} from "../../shell/src/stores/organization-drive-navigation";
beforeEach(()=>useOrganizationDriveNavigation.setState({request:null}));
describe("company drive navigation intents",()=>{
 it("consumes a shortcut once so a new Files window does not replay it",()=>{
  const store=useOrganizationDriveNavigation.getState();store.open("00000000-0000-4000-8000-000000000001","owner");
  const request=useOrganizationDriveNavigation.getState().request!;store.consume(request);
  expect(useOrganizationDriveNavigation.getState().request).toBeNull();
 });
 it("cannot consume a newer shortcut with an old request",()=>{
  const store=useOrganizationDriveNavigation.getState();store.open("00000000-0000-4000-8000-000000000001","owner");
  const old=useOrganizationDriveNavigation.getState().request!;store.open("00000000-0000-4000-8000-000000000002","owner");store.consume(old);
  expect(useOrganizationDriveNavigation.getState().request?.scopeId).toBe("00000000-0000-4000-8000-000000000002");
 });
 it("fails closed if an already opened requested drive disappears",()=>{
  expect(resolveOrganizationDriveNavigation(["other"],"requested",{scopeId:"requested",intentId:"intent"},"intent")).toEqual({scopeId:null,unavailable:true});
 });
 it("allows an explicit choice of another drive after an unavailable shortcut",()=>{
  expect(resolveOrganizationDriveNavigation(["other"],"other",{scopeId:"requested",intentId:"intent"},"intent")).toEqual({scopeId:"other",unavailable:false});
 });
});
