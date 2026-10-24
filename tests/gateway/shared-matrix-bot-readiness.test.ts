import {describe,it,expect,vi} from "vitest";
import {MATRIX_BOT_SELECTION} from "../../packages/contracts/src/index.js";
import {resolveSharedMatrixBotReadiness} from "../../packages/gateway/src/collaboration/shared-matrix-bot.js";
describe("shared Matrix first binding readiness",()=>{
 it("initializes the owner company's unbound Matrix Chat without consulting personal defaults",async()=>{
  const readiness=vi.fn().mockResolvedValue("ready"),standard=vi.fn().mockResolvedValue("unavailable");
  expect(await resolveSharedMatrixBotReadiness({ownerId:"user_host",selection:MATRIX_BOT_SELECTION,boundDriverKind:null,
    extension:{readiness} as never,standard})).toBe("ready");
  expect(readiness).toHaveBeenCalledWith("user_host",MATRIX_BOT_SELECTION);expect(standard).not.toHaveBeenCalled();
 });
 it("does not fall back when the Matrix extension or exact company selection is unavailable",async()=>{
  const standard=vi.fn().mockResolvedValue("ready");
  expect(await resolveSharedMatrixBotReadiness({ownerId:"user_host",selection:MATRIX_BOT_SELECTION,standard})).toBe("unavailable");
  expect(await resolveSharedMatrixBotReadiness({ownerId:"user_host",selection:{...MATRIX_BOT_SELECTION,model:"other"},boundDriverKind:"matrix_bot",standard})).toBe("unavailable");
  expect(standard).not.toHaveBeenCalled();
 });
 it("keeps established ordinary bindings on their trusted provider path",async()=>{
  const standard=vi.fn().mockResolvedValue("reconnect_required"),readiness=vi.fn().mockResolvedValue("ready");
  expect(await resolveSharedMatrixBotReadiness({ownerId:"user_host",selection:MATRIX_BOT_SELECTION,boundDriverKind:"claude_code",
    extension:{readiness} as never,standard})).toBe("reconnect_required");
  expect(standard).toHaveBeenCalledWith("user_host",MATRIX_BOT_SELECTION,"claude_code");expect(readiness).not.toHaveBeenCalled();
 });
});
