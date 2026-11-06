// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {nativeScheduledMessageFixture} from "../helpers/native-scheduled-message-fixture";
afterEach(cleanup);
const desktopHandoff = vi.hoisted(()=>({destination:vi.fn(),invoke:vi.fn()}));
vi.mock("../../desktop/src/renderer/src/features/chat/routine-action-confirmation",()=>({desktopRoutineConfirmationDestination:desktopHandoff.destination}));
vi.mock("../../desktop/src/renderer/src/lib/operator",()=>({invoke:desktopHandoff.invoke}));
it("does not open the old source browser if the Electron card unmounts during Computer lookup",async()=>{
 const {SourceChatRoutines}=await import("../../desktop/src/renderer/src/features/chat/SourceChatRoutines");
 let finish!:()=>void;desktopHandoff.destination.mockImplementation(async()=>{await new Promise<void>(r=>{finish=r;});return {connection:{platformHost:"https://app.example.test"},computer:{gatewayPath:"/vm/fixture"},current:()=>true};});
 const chat=nativeScheduledMessageFixture().record.chat;
 const card=render(<SourceChatRoutines chat={chat} ordinary revision={0}/>);fireEvent.click(screen.getByRole("button",{name:"Persistent task"}));card.unmount();await act(async()=>{finish();});expect(desktopHandoff.invoke).not.toHaveBeenCalled();
});
