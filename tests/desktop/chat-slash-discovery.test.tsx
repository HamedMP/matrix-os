// @vitest-environment jsdom
import React from "react";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {SharedChatComposer} from "../../desktop/src/renderer/src/features/chat/SharedChatComposer.js";
import {createCanonicalComposerSelection} from "../../desktop/src/renderer/src/features/chat/canonical-composer-state.js";
import {createCanonicalProviderCatalogFixture} from "../contracts/fixtures/canonical-chat.js";
import { appendSharedComposerText, mockSharedComposerPopoverLayout } from "./shared-chat-composer-test-utils.js";
let restorePopoverLayout: () => void;
beforeEach(() => { restorePopoverLayout = mockSharedComposerPopoverLayout(); });
afterEach(() => { cleanup(); restorePopoverLayout(); });
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

it.each([
  { text: "/", menuName: "Skills and commands", optionName: /review/i, tokenId: "skill-review" },
  { text: "@", menuName: "Add", optionName: /README.md/, tokenId: "file-readme" },
])("keeps the $menuName list outside a clipped composer and preserves editor focus", async ({ text, menuName, optionName, tokenId }) => {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances[0]!.skills = [{ id: "review", displayName: "Review", description: "Review changes", invocation: "/review" }];
  const onSubmit = vi.fn();
  function Harness() {
    const [value, setValue] = React.useState("");
    return <div data-testid="clipped-composer" className="overflow-hidden">
      <SharedChatComposer value={value} onChange={setValue} onSubmit={onSubmit} busy={false} catalog={catalog}
        selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false}
        resources={[{ kind: "file", id: "readme", label: "README.md" }]} menuSide="bottom" />
    </div>;
  }
  render(<Harness />);

  const editor = screen.getByLabelText("Message chat");
  editor.focus();
  await appendSharedComposerText(editor, text);
  const menu = await screen.findByRole("listbox", { name: menuName });
  expect(screen.getByTestId("clipped-composer").contains(menu)).toBe(false);
  expect(menu.getAttribute("data-preferred-side")).toBe("bottom");
  expect(document.activeElement).toBe(editor);

  const option = within(menu).getByRole("option", { name: optionName });
  expect(fireEvent.mouseDown(option)).toBe(false);
  fireEvent.click(option);
  expect(await screen.findByTestId(`composer-reference-token-${tokenId}`)).toBeTruthy();
  expect(document.activeElement).toBe(editor);
  expect(screen.queryByRole("listbox", { name: menuName })).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

it.each(["focus outside", "inert surface"] as const)("dismisses slash suggestions after %s", async (change) => {
  const catalog = createCanonicalProviderCatalogFixture();
  const composer = (inert: boolean) => <>
    <button type="button">Outside control</button>
    <div inert={inert || undefined}>
      <SharedChatComposer value="/" onChange={vi.fn()} onSubmit={vi.fn()} busy={false} catalog={catalog}
        selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false} />
    </div>
  </>;
  const view = render(composer(false));
  const editor = screen.getByLabelText("Message chat");
  act(() => editor.focus());
  expect(screen.getByRole("listbox", { name: "Skills and commands" })).toBeTruthy();
  expect(document.activeElement).toBe(editor);

  if (change === "focus outside") {
    const control = screen.getByRole("button", { name: "Outside control" });
    act(() => control.focus());
    expect(document.activeElement).toBe(control);
  } else {
    view.rerender(composer(true));
  }
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Skills and commands" })).toBeNull());
});

it("dismisses a pending @ search when its Chat surface becomes inactive", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const selection = createCanonicalComposerSelection(catalog);
  const oldResult = { kind: "file" as const, id: "old-notes", label: "notes-old.md" };
  const newResult = { kind: "file" as const, id: "new-notes", label: "notes-new.md" };
  let finishSearch!: (results: [typeof oldResult]) => void;
  const pendingResults = new Promise<[typeof oldResult]>(resolve => { finishSearch = resolve; });
  const resourceSearch = vi.fn<(query: string) => Promise<[typeof oldResult]>>()
    .mockReturnValueOnce(pendingResults)
    .mockResolvedValueOnce([newResult]);

  function Harness({ inactive }: { inactive: boolean }) {
    const [value, setValue] = React.useState("@notes");
    return <div inert={inactive || undefined}>
      <SharedChatComposer value={value} onChange={setValue} onSubmit={vi.fn()} busy={false}
        catalog={catalog} selection={selection} onSelectionChange={vi.fn()} instanceLocked={false}
        resourceSearch={resourceSearch} />
    </div>;
  }

  const view = render(<Harness inactive={false} />);
  const editor = screen.getByLabelText("Message chat");
  expect(resourceSearch).toHaveBeenCalledExactlyOnceWith("notes");
  expect(screen.queryByRole("listbox", { name: "Add" })).toBeNull();

  await act(async () => view.rerender(<Harness inactive />));
  await act(async () => view.rerender(<Harness inactive={false} />));
  await act(async () => finishSearch([oldResult]));
  expect(screen.queryByRole("listbox", { name: "Add" })).toBeNull();
  expect(editor.textContent).toBe("@notes");

  await appendSharedComposerText(editor, "-new");
  expect(resourceSearch).toHaveBeenLastCalledWith("notes-new");
  expect(await screen.findByRole("option", { name: /notes-new.md/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /notes-old.md/ })).toBeNull();
});

it.each(["pointer", "keyboard"] as const)("ignores deferred @ search results after %s dismissal", async (method) => {
  const catalog = createCanonicalProviderCatalogFixture();
  const resource = { kind: "file" as const, id: "readme", label: "README.md" };
  let finishSearch!: (results: [typeof resource]) => void;
  const pendingResults = new Promise<[typeof resource]>(resolve => { finishSearch = resolve; });
  const resourceSearch = vi.fn(() => pendingResults);

  render(<>
    <SharedChatComposer value="@read" onChange={vi.fn()} onSubmit={vi.fn()} busy={false} catalog={catalog}
      selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false}
      resourceSearch={resourceSearch} />
    <button type="button">Outside control</button>
  </>);

  const editor = screen.getByLabelText("Message chat");
  act(() => editor.focus());
  expect(resourceSearch).toHaveBeenCalledExactlyOnceWith("read");
  expect(screen.queryByRole("listbox", { name: "Add" })).toBeNull();
  const outside = screen.getByRole("button", { name: "Outside control" });
  if (method === "pointer") fireEvent.pointerDown(outside);
  else act(() => outside.focus());

  await act(async () => finishSearch([resource]));
  expect(document.querySelector('[role="listbox"][aria-label="Add"]')).toBeNull();
  expect(editor.textContent).toBe("@read");
});

it("uses a project manifest from slash without invoking an installed skill of the same name", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances[0]!.skills = [{ id: "global-review", displayName: "Review", description: "Installed review", invocation: "/review" }];
  const onSubmit = vi.fn();
  const read = vi.fn(async () => ({
    skills: [{ name: "review", source: ".agents/skills" }], instructions: [], mcpServers: [], incompleteSources: [],
  }));
  function Harness({ projectId }: { projectId: string }) {
    const [value, setValue] = React.useState("");
    return <SharedChatComposer value={value} onChange={setValue} onSubmit={onSubmit} busy={false} catalog={catalog}
      selection={createCanonicalComposerSelection(catalog)} onSelectionChange={vi.fn()} instanceLocked={false}
      projectSlashScope={{ scope: "preview", projectId, read }} />;
  }
  const view = render(<Harness projectId="alpha" />);
  const editor = screen.getByLabelText("Message chat");
  editor.focus();
  await appendSharedComposerText(editor, "/");
  const option = await screen.findByRole("option", { name: /review.*\.agents\/skills\/review\/SKILL.md/i });
  expect(screen.queryByRole("option", { name: /installed review/i })).toBeNull();
  fireEvent.click(option);
  expect(await screen.findByRole("button", { name: "Remove skill review" })).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringContaining(".agents/skills/review/SKILL.md"),
    invocations: [],
    projectSkill: expect.objectContaining({ projectId: "alpha" }),
  }));
  view.rerender(<Harness projectId="beta" />);
  expect(screen.queryByRole("button", { name: "Remove skill review" })).toBeNull();
  expect(onSubmit.mock.calls[0]![0].projectSkill.isCurrent()).toBe(false);
});
