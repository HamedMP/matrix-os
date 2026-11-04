import {cleanup,render,screen} from "@testing-library/react-native";
import {FlatList} from "react-native";
import * as mockContextMenu from "./context-menu-test-utils";
import {MessageList} from "../components/chat/MessageList";
import type {TranscriptMessage} from "../lib/canonical-chat-transcript";
jest.mock("micromark",()=>({micromark:jest.fn()}));
jest.mock("micromark-extension-gfm",()=>({gfm:jest.fn(),gfmHtml:jest.fn()}));
jest.mock("@expo/ui/swift-ui",()=>mockContextMenu.swiftUiContextMenuModule());
afterEach(cleanup);
const occurrence={routine:{routineId:"rt_"+"a".repeat(24),chatId:"chat_owner",proposal:{name:"Private task",prompt:"Return READY.",schedule:{kind:"cron",expr:"* * * * *",tz:"Asia/Shanghai"}}},fire:{fireId:"fire_"+"a".repeat(24),scheduledFor:"2026-11-02T01:00:00Z",status:"completed",attempts:1,failureCode:null}};
const message={id:"msg_scheduled",role:"user",text:"Return READY.",toolCalls:[],activities:[],isRunning:false,createdAt:Date.parse(occurrence.fire.scheduledFor),scheduled:occurrence} as unknown as TranscriptMessage;
it("draws the scheduled marker on its user bubble instead of a list header/footer",()=>{
  render(<MessageList messages={[message]} chatId="chat_owner"/>);
  expect(screen.getByText("Sent by scheduled task")).toBeTruthy();
  expect(screen.getAllByText("Return READY.")).toHaveLength(1);
  expect(screen.UNSAFE_getByType(FlatList).props.ListHeaderComponent).toBeNull();
  expect(screen.queryByText("Scheduled task history")).toBeNull();
});
it("renders the durable unadmitted failure as a read-only message, not a successful send",()=>{
  render(<MessageList messages={[{...message,scheduleEvent:true,scheduled:{...occurrence,fire:{...occurrence.fire,status:"failed",attempts:0,failureCode:"background_not_authorized"}}} as unknown as TranscriptMessage]} chatId="chat_owner"/>);
  expect(screen.getByText("Scheduled task did not run")).toBeTruthy();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.queryByText("background_not_authorized")).toBeNull();
});
