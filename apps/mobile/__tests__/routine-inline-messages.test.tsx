import {cleanup,fireEvent,render,screen} from "@testing-library/react-native";
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
  expect(screen.UNSAFE_getByType(FlatList).props.ListHeaderComponent).toBeUndefined();
  expect(screen.queryByText("Scheduled task history")).toBeNull();
});
it("renders the durable unadmitted failure as a read-only message, not a successful send",()=>{
  render(<MessageList messages={[{...message,scheduleEvent:true,scheduled:{...occurrence,fire:{...occurrence.fire,status:"failed",attempts:0,failureCode:"background_not_authorized"}}} as unknown as TranscriptMessage]} chatId="chat_owner"/>);
  expect(screen.getByText("Scheduled task did not run")).toBeTruthy();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.queryByText("background_not_authorized")).toBeNull();
});
it("attaches native system-input metadata once without changing safe text or adding a history row",()=>{
  render(<MessageList messages={[{...message,role:"system",text:"Scheduled task triggered.",scheduled:undefined,
    scheduledMessage:{timestamp:occurrence.fire.scheduledFor}}]} chatId="chat_owner"/>);
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
  expect(screen.getAllByText("Scheduled task triggered.")).toHaveLength(1);
  expect(screen.UNSAFE_getByType(FlatList).props.ListHeaderComponent).toBeUndefined();
});
it("keeps manual same-text input plain",()=>{
  render(<MessageList messages={[{...message,text:"Scheduled task triggered.",scheduled:undefined}]} chatId="chat_owner"/>);
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.getByText("Scheduled task triggered.")).toBeTruthy();
});
it("expands a long safe saved native input in its own bubble",()=>{
  const text="Only the safe stored message is available. ".repeat(10);
  render(<MessageList messages={[{...message,role:"system",text,scheduled:undefined,
    scheduledMessage:{timestamp:occurrence.fire.scheduledFor}}]} chatId="chat_owner"/>);
  expect(screen.getByText(text).props.numberOfLines).toBe(3);
  fireEvent.press(screen.getByRole("button",{name:"Show more"}));
  expect(screen.getByText(text).props.numberOfLines).toBeUndefined();
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
});
