// @vitest-environment jsdom
import React, {useState} from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../../shell/src/hooks/useGlobalShortcuts";
import { WebChatRailControls } from "../../shell/src/components/chat/WebChatRailControls";
import { WebChatSearchDialog } from "../../shell/src/components/chat/WebChatSearchDialog";
afterEach(cleanup);
function Surface({active,paletteOpen=false,onPalette}:{active:boolean;paletteOpen?:boolean;onPalette:()=>void}) {
  const [open,setOpen]=useState(false);
  useGlobalShortcuts(onPalette,paletteOpen);
  return <><WebChatRailControls active={active} onSearch={()=>setOpen(true)}/>
    {active&&open?<WebChatSearchDialog recent={[]} projects={[]} onClose={()=>setOpen(false)} onSelect={()=>{}} onProject={()=>{}} onOpenArchived={()=>{}}/>:null}</>;
}
it.each(["metaKey","ctrlKey"])("opens the real active Web Chat search with %s-K and leaves palette elsewhere",modifier=>{
  const palette=vi.fn(); const view=render(<Surface active onPalette={palette}/>);
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  const input=screen.getByRole("combobox",{name:"Search chats"});
  fireEvent.change(input,{target:{value:"kept query"}});
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(document.activeElement).toBe(input);expect((input as HTMLInputElement).value).toBe("kept query");
  expect(palette).not.toHaveBeenCalled();
  view.rerender(<Surface active={false} onPalette={palette}/>);
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(palette).toHaveBeenCalledOnce();expect(screen.queryByRole("combobox",{name:"Search chats"})).toBeNull();
});
it("retains palette ownership while open and unregisters Chat search on unmount",()=>{
  const palette=vi.fn(); const view=render(<Surface active paletteOpen onPalette={palette}/>);
  fireEvent.keyDown(window,{key:"k",metaKey:true});expect(palette).toHaveBeenCalledOnce();
  expect(screen.queryByRole("combobox",{name:"Search chats"})).toBeNull();
  view.unmount();fireEvent.keyDown(window,{key:"k",metaKey:true});expect(palette).toHaveBeenCalledOnce();
});
it("routes to the focused Chat when another visible Chat search mounts first",()=>{
  const palette=vi.fn(),background=vi.fn();
  render(<><WebChatRailControls active={false} onSearch={background}/><Surface active onPalette={palette}/></>);
  fireEvent.keyDown(window,{key:"k",metaKey:true});
  expect(document.activeElement).toBe(screen.getByRole("combobox",{name:"Search chats"}));
  expect(background).not.toHaveBeenCalled();expect(palette).not.toHaveBeenCalled();
});
