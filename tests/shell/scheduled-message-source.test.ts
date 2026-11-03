import {expect,it} from "vitest";
import {createCanonicalChatFixture} from "../contracts/fixtures/canonical-chat";
import {projectCanonicalTranscript} from "../../shell/src/lib/canonical-chat-terminal-notices";
import {canonicalChatPresentation} from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";

it("preserves the exact server turn identity only on that turn's input message across Web/Electron",()=>{
  const {snapshot}=createCanonicalChatFixture("completed");
  const request="req_routine_fire_"+"a".repeat(24);
  snapshot.turns[0]!.clientRequestId=request;
  const detail={...snapshot,record:{chat:snapshot.chat}};
  const web=projectCanonicalTranscript(detail);
  expect(web.find(row=>row.id===snapshot.turns[0]!.inputMessageId)?.metadata?.routineRequestId).toBe(request);
  expect(canonicalChatPresentation(snapshot)[0]?.routineRequestId).toBe(request);
});
