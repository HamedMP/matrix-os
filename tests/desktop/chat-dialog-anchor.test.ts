import { expect, it } from "vitest";
import { chatDialogOffset } from "@desktop/renderer/src/features/desktop-shell/chat-dialog-anchor";
it("centers recipe setup on the real main pane, including floating and hidden-sidebar windows", () => {
 expect(chatDialogOffset({ left:240,width:1272 },1512)).toBe(120);
 expect(chatDialogOffset({ left:340,width:460 },1512)).toBe(-186);
 expect(chatDialogOffset({ left:0,width:1512 },1512)).toBe(0);
 expect(chatDialogOffset({ left:0,width:0 },1512)).toBe(0);
});
