import {expect,it} from "vitest";
import {routineOriginBrowserUrl,sourceChatFromSearch} from "../../packages/ui/src/chat/routine-origin-browser";
it("hands off only validated source/interaction selectors and preserves the exact runtime",()=>{
 const creation=new URL(routineOriginBrowserUrl("https://app.matrix-os.com","/vm/fixture?runtime=dev","chat_source"));
 expect(creation.pathname).toBe("/vm/fixture");expect([...creation.searchParams.keys()]).toEqual(["runtime","sourceChat","launch"]);expect(creation.searchParams.get("sourceChat")).toBe("chat_source");
 const review=new URL(routineOriginBrowserUrl("https://app.matrix-os.com","/vm/fixture?runtime=dev","chat_source","in_abcdefgh"));expect(review.pathname).toBe("/vm/fixture/routine-cli/confirm");expect([...review.searchParams.keys()]).toEqual(["runtime","originChat","interaction"]);
 expect(sourceChatFromSearch(creation.search)).toBe("chat_source");expect(sourceChatFromSearch("?sourceChat=chat_one&sourceChat=chat_two")).toBeUndefined();expect(sourceChatFromSearch("?sourceChat=../owner")).toBeUndefined();
 expect(()=>routineOriginBrowserUrl("http://app.matrix-os.com","/vm/fixture","chat_source")).toThrow();expect(()=>routineOriginBrowserUrl("https://app.matrix-os.com","/vm/fixture?token=secret","chat_source")).toThrow();
});
it.each([
 "?launch=__chat__&sourceChat=chat_source&decision=approve",
 "?sourceChat=chat_source&launch=__chat__&launch=__terminal__",
 "?sourceChat=chat_source&launch=__chat__&runtime=a&runtime=b",
 "?sourceChat=chat_source&launch=__chat__&runtime=../bad",
 "?sourceChat=chat_source&launch=__terminal__",
])("ignores malformed source browser handoffs instead of applying a partial selector: %s",search=>{
 expect(sourceChatFromSearch(search)).toBeUndefined();
});
