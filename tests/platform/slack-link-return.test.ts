import {describe,it,expect} from "vitest";
import {buildPostAuthRedirectPath,normalizePostAuthRedirectPath} from "../../packages/platform/src/request-routing.js";
import {slackLinkReturnTarget} from "../../packages/platform/src/slack/link-return.js";
describe("Slack linking sign-in return",()=>{
 it("allows only the exact installer target without queries, fragments, encoding or external origins",()=>{
  expect(slackLinkReturnTarget("/slack/install")).toBe("/slack/install");
  for(const value of [undefined, ["/slack/install"], "/slack/install/", "/slack/install?next=/", "/slack/install#done", "/slack/%69nstall", "/slack/install\\evil", "//evil.test/slack/install", "https://app.matrix-os.com/slack/install", "https://evil.test/slack/install", "/slack/install\n"])
   expect(slackLinkReturnTarget(value)).toBeNull();
  for(const auth of ["sign-in","sign-up"])
   expect(buildPostAuthRedirectPath("https://app.matrix-os.com/"+auth+"?redirect_url="+encodeURIComponent("/slack/install"))).toBe("/slack/install");
 });
 it("preserves only the exact local tokenized Slack link through platform auth fallback",()=>{
  const target="/slack/link?token="+"a".repeat(43);
  expect(slackLinkReturnTarget(target)).toBe(target);
  expect(buildPostAuthRedirectPath("https://app.matrix-os.com"+target)).toBe(target);
  expect(normalizePostAuthRedirectPath(target)).toBe(target);
  expect(normalizePostAuthRedirectPath("https://app.matrix-os.com"+target)).toBe(target);
  expect(normalizePostAuthRedirectPath("https://evil.test"+target)).toBe("/");
  expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-in?redirect_url="+encodeURIComponent(target))).toBe(target);
  for(const unsafe of ["https://evil.test/slack/link?token="+"a".repeat(43),"//evil.test/slack/link?token="+"a".repeat(43),target+"&extra=x",target+"#fragment","/slack/link?token=bad",target+"&token="+"b".repeat(43)])
   expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-in?redirect_url="+encodeURIComponent(unsafe))).toBe("/");
 });
});
