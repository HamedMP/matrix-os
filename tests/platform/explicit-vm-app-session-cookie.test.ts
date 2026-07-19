import { describe, expect, it } from "vitest";
import { scopeExplicitVmAppSessionCookie } from "../../packages/platform/src/session-routing-cookie-rewrite.js";

describe("explicit VM app-session cookie scoping", () => {
  it("rewrites only the matching app-session cookie onto the explicit computer path", () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "matrix_app_session__notes=token; Path=/apps/notes/; HttpOnly; SameSite=Strict",
    );
    headers.append("set-cookie", "unrelated=value; Path=/; HttpOnly");

    scopeExplicitVmAppSessionCookie(headers, {
      handle: "alice-preview",
      runtimeSlot: "pr-1018",
      upstreamPath: "/api/apps/notes/session",
    });

    expect(headers.getSetCookie()).toEqual([
      "matrix_app_session__notes=token; Path=/vm/alice-preview/~runtime/pr-1018/apps/notes/; HttpOnly; SameSite=Strict",
      "unrelated=value; Path=/; HttpOnly",
    ]);
  });

  it("leaves cookies unchanged for non-session routes", () => {
    const headers = new Headers({
      "set-cookie": "matrix_app_session__notes=token; Path=/apps/notes/; HttpOnly",
    });

    scopeExplicitVmAppSessionCookie(headers, {
      handle: "alice-preview",
      upstreamPath: "/apps/notes/",
    });

    expect(headers.getSetCookie()).toEqual([
      "matrix_app_session__notes=token; Path=/apps/notes/; HttpOnly",
    ]);
  });

  it("rejects unvalidated route components before constructing a cookie path", () => {
    const headers = new Headers({
      "set-cookie": "matrix_app_session__notes=token; Path=/apps/notes/; HttpOnly",
    });

    scopeExplicitVmAppSessionCookie(headers, {
      handle: "alice/../../primary",
      runtimeSlot: "pr-1018\r\nInjected=true",
      upstreamPath: "/api/apps/notes/session",
    });

    expect(headers.getSetCookie()).toEqual([
      "matrix_app_session__notes=token; Path=/apps/notes/; HttpOnly",
    ]);
  });
});
