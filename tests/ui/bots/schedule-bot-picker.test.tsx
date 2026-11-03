// @vitest-environment jsdom
import React from "react";
import {afterEach, expect, it, vi} from "vitest";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {ScheduleBotPicker} from "../../../packages/ui/src/chat-agents/bots/ScheduleBotPicker.js";
import {clientFixture, saved} from "../../desktop/chat-agents-fixture";
import type {ChatAgentClient} from "../../../packages/ui/src/chat-agents/client.js";
afterEach(cleanup);
function setup(ensure = vi.fn(async () => "chat_saved")) {
 const base = clientFixture(); base.list.mockResolvedValue({enabled: true, agents: [{...saved, recipeRef: {recipeId: "writer", version: "1"}}]});
 const client = {...base, bots: {ensureDirectChat: ensure}} as unknown as ChatAgentClient;
 return {client, ensure};
}
it("opens the exact existing private Chat once across repeated clicks", async () => {
 let finish!: (id: string) => void;
 const {client, ensure} = setup(vi.fn(() => new Promise<string>(resolve => {finish = resolve;}))), open = vi.fn();
 render(<ScheduleBotPicker client={client} onOpen={open} onDone={vi.fn()} onBack={vi.fn()} onManage={vi.fn()}/>);
 const choice = await screen.findByRole("button", {name: "Schedule with Meeting helper"});
 fireEvent.click(choice);fireEvent.click(choice);
 expect(ensure).toHaveBeenCalledTimes(1);
 await act(async () => finish("chat_saved"));
 expect(open).toHaveBeenCalledExactlyOnceWith("chat_saved");
 expect(client.update).not.toHaveBeenCalled();
});
it("does not navigate when the person leaves before Chat resolution", async () => {
 let finish!: (id: string) => void;
 const {client} = setup(vi.fn(() => new Promise<string>(resolve => {finish = resolve;}))), open = vi.fn();
 const view = render(<ScheduleBotPicker client={client} onOpen={open} onDone={vi.fn()} onBack={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole("button", {name: "Schedule with Meeting helper"}));
 view.unmount(); await act(async () => finish("chat_saved"));
 expect(open).not.toHaveBeenCalled();
});
it("keeps choices and shows a safe error when opening fails", async () => {
 const {client} = setup(vi.fn().mockRejectedValue(new Error("secret /home/credentials")));
 render(<ScheduleBotPicker client={client} onOpen={vi.fn()} onDone={vi.fn()} onBack={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole("button", {name: "Schedule with Meeting helper"}));
 expect((await screen.findByRole("alert")).textContent).not.toMatch(/secret|credentials/);
 await waitFor(() => expect((screen.getByRole("button", {name: "Schedule with Meeting helper"}) as HTMLButtonElement).disabled).toBe(false));
});

it("does not offer legacy non-scheduling agents as schedule targets", async () => {
 const {client} = setup();
 vi.spyOn(client, "list").mockResolvedValue({enabled: true, agents: [{...saved, recipeRef: {recipeId: "writer", version: "1"}}, {...saved, id: "bot_legacy001", name: "Legacy agent"}]});
 render(<ScheduleBotPicker client={client} onOpen={vi.fn()} onDone={vi.fn()} onBack={vi.fn()} onManage={vi.fn()}/>);
 await screen.findByRole("button", {name: "Schedule with Meeting helper"});
 expect(screen.queryByRole("button", {name: "Schedule with Legacy agent"})).toBeNull();
});
