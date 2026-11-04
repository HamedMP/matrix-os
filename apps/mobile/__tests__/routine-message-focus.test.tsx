import {act,cleanup,render} from "@testing-library/react-native";
import {AppState,Text,type AppStateStatus} from "react-native";
import {useNativeRoutineMessages} from "../components/agents/schedules/use-routine-messages";

let mockFocused=true;
const originalAppState=AppState.currentState;
const mockApi={list:jest.fn(async()=>({items:[],pending:[],nextCursor:null})),detail:jest.fn(),control:jest.fn(),review:jest.fn()};
const mockSession=async()=>null;
jest.mock("expo-router",()=>({useIsFocused:()=>mockFocused}));
jest.mock("../lib/queries/use-active-gateway",()=>({useActiveGateway:()=>({session:mockSession,userId:"owner",computerKey:"preview",ready:true})}));
jest.mock("../lib/requests/routines",()=>({createNativeRoutineClient:()=>mockApi}));
function Probe(){useNativeRoutineMessages("chat_saved",true);return <Text>Private Chat</Text>;}
beforeEach(()=>{jest.useFakeTimers();AppState.currentState="active";mockFocused=true;mockApi.list.mockClear();});
afterEach(()=>{cleanup();AppState.currentState=originalAppState;jest.useRealTimers();jest.restoreAllMocks();});
it("stops scheduled-status reads for retained off-screen Chat routes",async()=>{
  const view=render(<Probe/>);
  await act(async()=>{});
  const reads=mockApi.list.mock.calls.length;expect(reads).toBe(2);
  mockFocused=false;view.rerender(<Probe/>);
  await act(async()=>{jest.advanceTimersByTime(30_000);});
  expect(mockApi.list.mock.calls.length).toBe(reads);
});
it("stops polling while the app is backgrounded",async()=>{
  let change:((state:AppStateStatus)=>void)|undefined;
  jest.spyOn(AppState,"addEventListener").mockImplementation((_event,listener)=>{change=listener;return{remove:jest.fn()};});
  render(<Probe/>);await act(async()=>{});
  const reads=mockApi.list.mock.calls.length;
  expect(reads).toBe(2);
  await act(async()=>{change?.("background");});
  await act(async()=>{jest.advanceTimersByTime(30_000);});
  expect(mockApi.list.mock.calls.length).toBe(reads);
});
