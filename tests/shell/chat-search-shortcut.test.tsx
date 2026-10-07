// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../../shell/src/hooks/useGlobalShortcuts";
import { WebChatRailControls } from "../../shell/src/components/chat/WebChatRailControls";
afterEach(cleanup);
function Surface({active,paletteOpen=false,onPalette}:{active:boolean;paletteOpen?:boolean;onPalette:()=>void}) {
  useGlobalShortcuts(onPalette,paletteOpen);
  return <WebChatRailControls active={active} query="kept query" onQuery={()=>{}}/>;
}
it.each(["metaKey","ctrlKey"])("focuses active Web Chat search with %s-K and leaves palette elsewhere",modifier=>{
  const palette=vi.fn(); const view=render(<Surface active onPalette={palette}/>);
  const input=screen.getByRole("textbox",{name:"Search chats"});
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("kept query");
  expect(palette).not.toHaveBeenCalled();
  input.blur();view.rerender(<Surface active={false} onPalette={palette}/>);
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(palette).toHaveBeenCalledOnce();
  expect(document.activeElement).not.toBe(input);
});
it("retains palette ownership while open and unregisters Chat search on unmount",()=>{
  const palette=vi.fn(); const view=render(<Surface active paletteOpen onPalette={palette}/>);
  fireEvent.keyDown(window,{key:"k",metaKey:true});
  expect(palette).toHaveBeenCalledOnce();
  expect(document.activeElement).not.toBe(screen.getByRole("textbox",{name:"Search chats"}));
  view.unmount();fireEvent.keyDown(window,{key:"k",metaKey:true});
  expect(palette).toHaveBeenCalledOnce();
});

it("routes to the focused Chat when another visible Chat search mounts first",()=>{
  const palette=vi.fn();
  render(<><WebChatRailControls active={false} query="background" onQuery={()=>{}}/><Surface active onPalette={palette}/></>);
  fireEvent.keyDown(window,{key:"k",metaKey:true});
  const inputs=screen.getAllByRole("textbox",{name:"Search chats"});
  expect(document.activeElement).toBe(inputs[1]);
  expect(palette).not.toHaveBeenCalled();
});
