// @vitest-environment jsdom
import React from "react";
import {cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {SharedChatComposer} from "../../desktop/src/renderer/src/features/chat/SharedChatComposer.js";
import {createCanonicalComposerSelection} from "../../desktop/src/renderer/src/features/chat/canonical-composer-state.js";
import {createCanonicalProviderCatalogFixture} from "../contracts/fixtures/canonical-chat.js";
import "./shared-chat-composer-test-utils.js";
afterEach(cleanup);
it("explains an authoritative empty Skill catalog instead of showing nothing on slash", () => {
 const catalog=createCanonicalProviderCatalogFixture();
 render(<SharedChatComposer value="/" onChange={vi.fn()} onSubmit={vi.fn()} busy={false} catalog={catalog}
  selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false}/>);
 expect(screen.getByRole("listbox",{name:"Skills and commands"})).toBeTruthy();
 expect(within(screen.getByRole("listbox",{name:"Skills and commands"})).getByRole("status").textContent).toBe("No skills or commands are available for this model.");
 expect(screen.queryByRole("option")).toBeNull();
 fireEvent.keyDown(screen.getByLabelText("Message chat"),{key:"Escape"});
 expect(screen.queryByRole("listbox",{name:"Skills and commands"})).toBeNull();
});

it.each(["provider", "refresh"])("keeps keyboard selection valid after a narrower Skill catalog (%s)", async change => {
 const catalog=createCanonicalProviderCatalogFixture();
 catalog.instances[0]!.skills=[
  {id:"review",displayName:"Review",description:"Review changes",invocation:"/review"},
  {id:"research",displayName:"Research",description:"Research sources",invocation:"/research"},
 ];
 const props={value:"/",onChange:vi.fn(),onSubmit:vi.fn(),busy:false,catalog,selection:createCanonicalComposerSelection(catalog),onSelectionChange:vi.fn(),instanceLocked:false};
 const view=render(<SharedChatComposer {...props}/>);
 fireEvent.keyDown(screen.getByLabelText("Message chat"),{key:"ArrowDown"});
 expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
 const nextId=change === "provider" ? "other" : props.selection!.instanceId;
 const nextCatalog={...catalog,instances:[{...catalog.instances[0]!,id:nextId,skills:[{id:"other",displayName:"Other",description:"Current runtime Skill",invocation:"/other"}]}]};
 view.rerender(<SharedChatComposer {...props} catalog={nextCatalog} selection={{...props.selection!,instanceId:nextId}}/>);
 expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("true");
 fireEvent.keyDown(screen.getByLabelText("Message chat"),{key:"Enter"});
 expect(await screen.findByTestId("composer-reference-token-skill-other")).toBeTruthy();
 expect(props.onSubmit).not.toHaveBeenCalled();
});
it("keeps slash discoverable while fresh Skill metadata is loading and exposes no false choices", () => {
 const catalog=createCanonicalProviderCatalogFixture();
 render(<SharedChatComposer value="/" onChange={vi.fn()} onSubmit={vi.fn()} busy={false} catalog={catalog}
  selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false} providerCatalogLoading/>);
 expect(within(screen.getByRole("listbox",{name:"Skills and commands"})).getByRole("status").textContent).toBe("Loading skills and commands…");
 expect(screen.queryByRole("option")).toBeNull();
});

it("does not preserve dismissal across a different Chat draft or provider instance", () => {
 const catalog=createCanonicalProviderCatalogFixture();
 catalog.instances[0]!.skills=[{id:"review",displayName:"Review",description:"Review changes",invocation:"/review"}];
 const props={value:"/",onChange:vi.fn(),onSubmit:vi.fn(),busy:false,catalog,selection:createCanonicalComposerSelection(catalog),onSelectionChange:vi.fn(),instanceLocked:false};
 const view=render(<SharedChatComposer {...props} draftScopeKey="one"/>);
 fireEvent.keyDown(screen.getByLabelText("Message chat"),{key:"Escape"});
 expect(screen.queryByRole("listbox",{name:"Skills and commands"})).toBeNull();
 view.rerender(<SharedChatComposer {...props} draftScopeKey="two"/>);
 expect(screen.getByRole("option").textContent).toContain("/review");
 const emptyCatalog={...catalog,instances:catalog.instances.map(instance=>({...instance,id:"other",skills:[]}))};
 view.rerender(<SharedChatComposer {...props} catalog={emptyCatalog} selection={{...props.selection!,instanceId:"other"}} draftScopeKey="two"/>);
 expect(screen.queryByRole("option")).toBeNull();
 expect(within(screen.getByRole("listbox",{name:"Skills and commands"})).getByRole("status").textContent).toBe("No skills or commands are available for this model.");
});
