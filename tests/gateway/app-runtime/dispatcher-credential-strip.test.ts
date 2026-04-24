import { describe, it, expect } from "vitest";
import {
  sanitizeAppResponseHeaders,
  sanitizeCookieHeader,
} from "../../../packages/gateway/src/app-runtime/dispatcher.js";

describe("dispatcher credential stripping (spec 063 regression)", () => {
  describe("sanitizeCookieHeader", () => {
    it("drops all matrix_app_session__* cookies", () => {
      const input =
        "matrix_app_session__hello-vite=abc; matrix_app_session__games=def; user_pref=dark";
      expect(sanitizeCookieHeader(input)).toBe("user_pref=dark");
    });

    it("drops Clerk __session cookies", () => {
      const input = "__session=clerk-jwt; csrf=xyz";
      expect(sanitizeCookieHeader(input)).toBe("csrf=xyz");
    });

    it("returns null when every cookie is stripped", () => {
      const input =
        "matrix_app_session__a=1; matrix_app_session__b=2; __session=3";
      expect(sanitizeCookieHeader(input)).toBeNull();
    });

    it("preserves app-owned cookies", () => {
      const input = "theme=dark; locale=en-US";
      expect(sanitizeCookieHeader(input)).toBe("theme=dark; locale=en-US");
    });

    it("tolerates whitespace and empty entries", () => {
      const input = " ; theme=dark ;  matrix_app_session__x=y ; ";
      expect(sanitizeCookieHeader(input)).toBe("theme=dark");
    });
  });

  describe("sanitizeAppResponseHeaders", () => {
    it("drops shell-origin Set-Cookie headers from node app responses", () => {
      const headers = sanitizeAppResponseHeaders(new Headers({
        "Set-Cookie": "__session=attacker; Path=/",
        "X-Powered-By": "node",
        "Content-Type": "text/plain",
      }));

      expect(headers.get("set-cookie")).toBeNull();
      expect(headers.get("x-powered-by")).toBeNull();
      expect(headers.get("content-type")).toBe("text/plain");
    });
  });
});
