import {describe,expect,it} from "vitest";
import {LocalChatImportDisplayError,LocalChatPreviewError,LocalChatTransferError,localChatImportErrorText} from "../../packages/contracts/src/local-chat-import/index.js";
describe("safe native importer recovery guidance",()=>{
 it("retains known changed-source and verification guidance through the display boundary",()=>{for(const error of [new LocalChatPreviewError("source_changed"),new LocalChatTransferError("failed")]){const message=localChatImportErrorText(error);expect(localChatImportErrorText(new LocalChatImportDisplayError(message))).toBe(message);}});
 it("replaces raw provider/path/credential text and overlong messages",()=>{for(const message of ["postgres://private/secret","/Users/private/.codex/auth.json","x".repeat(2000)]){expect(localChatImportErrorText(new LocalChatImportDisplayError(message))).toBe("Chat import unavailable. Check your connection and Matrix version, then retry. Your local file was not changed.");}});
});
