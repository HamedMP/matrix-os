// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWebChatHistory } from "../../shell/src/components/chat/useWebChatHistory";

afterEach(cleanup);
it.each(["rejected", "partial"])("keeps a newer archive notice when an older Undo is %s", async outcome=>{
 let finish!: (ids: readonly string[])=>void, fail!: (cause: Error)=>void;
 const restoreMany=vi.fn(()=>new Promise<readonly string[]>((resolve,reject)=>{finish=resolve;fail=reject;}));
 const archiveProjectChats=vi.fn(async()=>({archived:[{chatId:"chat_a",revision:2},{chatId:"chat_b",revision:2}],archivedCount:2,skippedCount:0}));
 const archive=vi.fn(async()=>({chatId:"chat_new",revision:2}));
 function Harness(){const history=useWebChatHistory({archive,archiveProjectChats,restoreMany});return <>
  <button onClick={()=>void history.archiveProject("project","project","First project")}>Archive project</button>
  <button onClick={()=>void history.archiveChat({id:"chat_new",title:"Newer chat",preview:"",messageCount:1,updatedAt:1})}>Archive newer</button>{history.toast}
 </>;}
 render(<Harness/>);
 fireEvent.click(screen.getByRole("button",{name:"Archive project"}));
 fireEvent.click(await screen.findByRole("button",{name:"Undo"}));
 await waitFor(()=>expect(restoreMany).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByRole("button",{name:"Archive newer"}));
 await screen.findByText("Archived Newer chat");
 await act(async()=>{if(outcome==="rejected")fail(new Error("RestoreUnavailable"));else finish(["chat_a"]);});
 expect(screen.getByText("Archived Newer chat")).toBeTruthy();
 expect(screen.queryByText("Chats could not be restored. Try again.")).toBeNull();
});
