// @vitest-environment jsdom
import React,{useState} from "react";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {ChatInput} from "../../shell/src/components/chat/ChatInput.js";
import type {CanonicalProviderInstanceDescriptor} from "@matrix-os/contracts";
import type {ChatComposerDraft} from "../../shell/src/components/chat/useChatComposerDraft.js";
import {createCanonicalProviderCatalogFixture} from "../contracts/fixtures/canonical-chat.js";
vi.mock("../../shell/src/components/chat/ChatMentionPicker.js",()=>({ChatMentionPicker:()=>null}));
afterEach(cleanup);
const instance:CanonicalProviderInstanceDescriptor={...createCanonicalProviderCatalogFixture().instances[0]!,skills:[
 {id:"review",displayName:"Review",description:"Review changes",invocation:"/review"},
 {id:"research",displayName:"Research",description:"Research sources",invocation:"/research"},
]};
const capture={isSupported:()=>false,start:vi.fn()};
function Harness({selected=instance,scope="one",loading=false,submit=vi.fn(),initial="/"}: {
 selected?:CanonicalProviderInstanceDescriptor;scope?:string;loading?:boolean;submit?:(text:string)=>void;initial?:string;
}) {
 const [text,setText]=useState(initial);
 const composer={text,setText,resources:[],setResources:vi.fn(),setDraft:vi.fn(),clear:vi.fn(),requestId:"req_web_slash"} as unknown as ChatComposerDraft;
 return <ChatInput composer={composer} scope={scope} permissionMode="supervised" connected busy={false} attachmentsEnabled
  onSubmit={submit} slashInstance={selected} slashCatalogLoading={loading} speechCaptureAdapter={capture}/>;
}
it("uses only selected runtime descriptors and inserts the selected Skill without submitting",()=>{
 const submit=vi.fn();render(<Harness submit={submit}/>);
 expect(screen.getAllByRole("option").length).toBe(2);
 fireEvent.click(screen.getByRole("option",{name:/\/review/}));
 expect((screen.getByLabelText("Message chat") as HTMLTextAreaElement).value).toBe("/review ");
 expect(submit).not.toHaveBeenCalled();expect(screen.queryByRole("listbox")).toBeNull();
});
it("filters, selects by keyboard and preserves ordinary Enter submission after insertion",async()=>{
 const submit=vi.fn();render(<Harness submit={submit}/>);
 const input=screen.getByLabelText("Message chat");
 fireEvent.change(input,{target:{value:"Please /rese",selectionStart:12}});
 expect(screen.getAllByRole("option").length).toBe(1);
 fireEvent.keyDown(input,{key:"Enter"});
 expect((input as HTMLTextAreaElement).value).toBe("Please /research ");
 fireEvent.keyDown(input,{key:"Enter"});
 await waitFor(()=>expect(submit).toHaveBeenCalled());
 expect(submit.mock.calls[0]?.[0]).toBe("Please /research");
});
it("allows Arrow navigation and Escape without discarding the slash draft",()=>{
 render(<Harness/>);const input=screen.getByLabelText("Message chat");
 fireEvent.keyDown(input,{key:"ArrowDown"});expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
 fireEvent.keyDown(document.activeElement!,{key:"ArrowDown"});expect(document.activeElement).toBe(screen.getAllByRole("option")[1]);
 fireEvent.keyDown(document.activeElement!,{key:"Escape"});expect(screen.queryByRole("listbox")).toBeNull();
 expect((input as HTMLTextAreaElement).value).toBe("/");
});
it("does not borrow previous runtime or ordinary provider Skills for a Bot Chat",()=>{
 const view=render(<Harness/>);expect(screen.getAllByRole("option").length).toBe(2);
 const empty={...instance,id:"matrix_pi_default",skills:[]};
 view.rerender(<Harness selected={empty}/>);expect(screen.queryByRole("option")).toBeNull();
 expect(screen.getByRole("status").textContent).toBe("No skills or commands are available for this model.");
 // The Bot Chat host supplies no ordinary-provider descriptor.
 view.rerender(<ChatInput composer={{text:"/",setText:vi.fn(),resources:[],setResources:vi.fn(),requestId:"req_bot"} as unknown as ChatComposerDraft}
 scope="bot" permissionMode="default" connected busy={false} attachmentsEnabled={false} onSubmit={vi.fn()} speechCaptureAdapter={capture}/>);
 expect(screen.queryByRole("option")).toBeNull();expect(screen.getByRole("status").textContent).toBe("Skills and commands are unavailable in this Chat.");
});
it("clears dismissed status on a new Chat scope and avoids stale options while loading",()=>{
 const view=render(<Harness/>);fireEvent.keyDown(screen.getByLabelText("Message chat"),{key:"Escape"});
 view.rerender(<Harness scope="two" loading/>);
 expect(screen.getByRole("status").textContent).toBe("Loading skills and commands…");expect(screen.queryByRole("option")).toBeNull();
 view.rerender(<Harness scope="two"/>);expect(screen.getAllByRole("option").length).toBe(2);
});

it("discovers a Skill at the cursor inside a draft and preserves following text",()=>{
 render(<Harness initial="Please / and keep this"/>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 input.setSelectionRange(8,8);fireEvent.select(input);
 expect(screen.getAllByRole("option").length).toBe(2);
 fireEvent.click(screen.getByRole("option",{name:/\/review/}));
 expect(input.value).toBe("Please /review  and keep this");
 expect(input.selectionStart).toBe(15);
});

it.each([
 {draft:"/review",cursor:3,expected:"/research ",caret:10},
 {draft:"Please /review and keep this",cursor:10,expected:"Please /research  and keep this",caret:17},
])("replaces the complete slash token when selecting inside $draft",({draft,cursor,expected,caret})=>{
 const submit=vi.fn();render(<Harness initial={draft} submit={submit}/>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 input.setSelectionRange(cursor,cursor);fireEvent.select(input);
 fireEvent.click(screen.getByRole("option",{name:/\/research/}));
 expect(input.value).toBe(expected);expect(input.selectionStart).toBe(caret);
 expect(document.activeElement).toBe(input);expect(submit).not.toHaveBeenCalled();
});

it("positions the slash popup above the textarea card without adding a composer flow row",()=>{
 render(<Harness/>);
 const popup=screen.getByRole("listbox");const input=screen.getByLabelText("Message chat");
 expect(popup.classList.contains("absolute")).toBe(true);
 expect(popup.classList.contains("bottom-full")).toBe(true);
 expect(popup.parentElement).toBe(input.parentElement);
 expect(popup.parentElement?.classList.contains("relative")).toBe(true);
});

it.each([false,true])("dismisses outside pointer input without changing the draft or stealing focus (loading=$0)",loading=>{
 render(<><Harness loading={loading}/><button type="button">Outside control</button></>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 input.focus();
 fireEvent.pointerDown(input);expect(screen.getByRole("listbox")).toBeTruthy();
 const outside=screen.getByRole("button",{name:"Outside control"});
 outside.focus();fireEvent.pointerDown(outside);
 expect(screen.queryByRole("listbox")).toBeNull();expect(input.value).toBe("/");
 expect(document.activeElement).toBe(outside);
});

it.each([
 {loading:true,selected:instance,initial:"/"},
 {loading:false,selected:{...instance,skills:[]},initial:"/"},
 {loading:false,selected:instance,initial:"/no-match"},
])("does not submit or select stale entries from an empty slash popup ($initial, loading=$loading)",async props=>{
 const submit=vi.fn();render(<Harness {...props} submit={submit}/>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 expect(screen.queryByRole("option")).toBeNull();
 fireEvent.keyDown(input,{key:"Enter"});expect(input.value).toBe(props.initial);
 expect(submit).not.toHaveBeenCalled();expect(screen.getByRole("listbox")).toBeTruthy();
 fireEvent.keyDown(input,{key:"Escape"});expect(screen.queryByRole("listbox")).toBeNull();
});


it("dismisses only the slash token at the caret and lets another token open",()=>{
 const submit=vi.fn();render(<Harness initial="/review and /research" submit={submit}/>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 input.setSelectionRange(3,3);fireEvent.select(input);
 fireEvent.keyDown(input,{key:"Escape"});expect(screen.queryByRole("listbox")).toBeNull();
 input.setSelectionRange(5,5);fireEvent.select(input);expect(screen.queryByRole("listbox")).toBeNull();
 input.setSelectionRange(input.value.length,input.value.length);fireEvent.select(input);
 expect(screen.getByRole("option",{name:/\/research/})).toBeTruthy();
 expect(input.value).toBe("/review and /research");expect(submit).not.toHaveBeenCalled();
});
it("returns focus to the composer before refresh removes a focused Skill",()=>{
 const submit=vi.fn();const view=render(<Harness submit={submit}/>);
 const input=screen.getByLabelText("Message chat") as HTMLTextAreaElement;
 fireEvent.keyDown(input,{key:"ArrowDown"});expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
 view.rerender(<Harness submit={submit} loading/>);
 expect(screen.queryByRole("option")).toBeNull();expect(document.activeElement).toBe(input);
 view.rerender(<Harness submit={submit}/>);
 expect(document.activeElement).toBe(input);fireEvent.keyDown(input,{key:"ArrowDown"});
 expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
 expect(input.value).toBe("/");expect(submit).not.toHaveBeenCalled();
});
it("keeps outside focus when refresh removes an unfocused Skill",()=>{
 const view=render(<><Harness/><button type="button">Outside focus</button></>);
 const outside=screen.getByRole("button",{name:"Outside focus"});outside.focus();
 view.rerender(<><Harness loading/><button type="button">Outside focus</button></>);
 expect(document.activeElement).toBe(outside);
});
