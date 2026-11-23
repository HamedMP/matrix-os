// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBody } from "../../../../home/apps/mail/src/html";
import { buildFrameDocument, DEFAULT_FRAME_THEME, FRAME_SANDBOX, frameContentSecurityPolicy } from "../../../../home/apps/mail/src/html/frame-document";
import { buildLayoutProjection } from "../../../../home/apps/mail/src/html/layout-projection";
import { FORBIDDEN_SELECTOR, PNG_DATA_URL } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function frame(): HTMLIFrameElement {
  return screen.getByTitle("Message content") as HTMLIFrameElement;
}

function frameDocument(): Document {
  return new DOMParser().parseFromString(frame().getAttribute("srcdoc") ?? "", "text/html");
}

function policy(doc: Document): string {
  return doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
}

const WITH_IMAGES = '<p>Hello</p><img src="https://cdn.example/banner.png" alt="Banner" width="600" height="200"><img src="https://t.example/open" width="1" height="1">';
const WITH_QUOTE = '<div>Sounds good.</div><div class="gmail_quote">On Mon, Ada wrote:<blockquote>Shall we meet?</blockquote></div>';

describe("MessageBody", () => {
  it("renders the mail in a sandbox that allows neither scripts nor the app's origin", () => {
    render(<MessageBody html={'<p onclick="alert(1)">Hello <b>there</b></p><script>alert(1)</script><form action="https://evil.example/"><input name="pw"></form>'} text="" />);
    const sandbox = (frame().getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(sandbox.sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox"]);
    expect(FRAME_SANDBOX).not.toMatch(/allow-(scripts|same-origin|forms|top-navigation|modals|downloads|pointer-lock)/);
    expect(frame().hasAttribute("src")).toBe(false);
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");

    const doc = frameDocument();
    expect(doc.querySelectorAll(FORBIDDEN_SELECTOR.replace("style,", "").replace("meta,", "").replace("base,", "").replace("title,", "")).length).toBe(0);
    expect(doc.querySelector(".mx-root p")?.innerHTML).toBe("Hello <b>there</b>");
    expect(Array.from(doc.querySelectorAll("*")).some((element) => Array.from(element.attributes).some((attribute) => attribute.name.startsWith("on")))).toBe(false);
  });

  it("ships a policy that forbids scripts, frames, forms, fonts and remote loads", () => {
    render(<MessageBody html={WITH_IMAGES} text="" />);
    const doc = frameDocument();
    const csp = policy(doc);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:;");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/script-src|https:|http:|\*|unsafe-eval|blob:/);
    expect(csp).toBe(frameContentSecurityPolicy(false));
    // The policy has to be in force before any mail markup is parsed.
    const head = Array.from(doc.head.children).map((element) => element.tagName.toLowerCase());
    expect(head.slice(0, 2)).toEqual(["meta", "meta"]);
    expect(doc.head.children[1].getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(doc.querySelector("base")?.getAttribute("target")).toBe("_blank");
    expect(doc.querySelector("base")?.hasAttribute("href")).toBe(false);
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
  });

  it("blocks remote images until the owner loads them for this message", () => {
    const onLoadImages = vi.fn();
    const { rerender } = render(<MessageBody html={WITH_IMAGES} text="" messageKey="m1" onLoadImages={onLoadImages} />);
    expect(frameDocument().querySelectorAll("img").length).toBe(0);
    expect(frameDocument().querySelector(".mx-image-blocked")?.textContent).toBe("Banner");
    expect(screen.getByRole("status").textContent).toContain("1 remote image hidden");

    fireEvent.click(screen.getByRole("button", { name: "Load images" }));
    expect(onLoadImages).toHaveBeenCalledTimes(1);
    const doc = frameDocument();
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/banner.png");
    expect(doc.querySelectorAll("img").length).toBe(1);
    expect(policy(doc)).toContain("img-src data: https: http:;");
    expect(screen.queryByRole("button", { name: "Load images" })).toBeNull();

    rerender(<MessageBody html={WITH_IMAGES} text="" messageKey="m2" onLoadImages={onLoadImages} />);
    expect(frameDocument().querySelectorAll("img").length).toBe(0);
    expect(screen.getByRole("button", { name: "Load images" })).toBeTruthy();
  });

  it("can start with images loaded and shows no notice when there are none", () => {
    const { rerender } = render(<MessageBody html={WITH_IMAGES} text="" defaultLoadImages />);
    expect(frameDocument().querySelectorAll("img").length).toBe(1);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<MessageBody html="<p>No pictures</p>" text="" messageKey="other" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(policy(frameDocument())).toContain("img-src data:;");
  });

  it("collapses the quoted trail behind a toggle", () => {
    render(<MessageBody html={WITH_QUOTE} text="" />);
    const toggle = screen.getByRole("button", { name: "Show quoted text" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(frameDocument().body.textContent).not.toContain("Shall we meet?");
    fireEvent.click(toggle);
    expect(frameDocument().body.textContent).toContain("Shall we meet?");
    expect(screen.getByRole("button", { name: "Hide quoted text" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("renders a plain-text message with links", () => {
    render(<MessageBody html={null} text={"Hi <b>Ada</b>,\nsee https://example.com/a"} />);
    const doc = frameDocument();
    expect(doc.querySelector(".mx-plain")?.textContent).toBe("Hi <b>Ada</b>,see https://example.com/a");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(doc.querySelector("b")).toBeNull();
  });

  it("shows inline images from attachments and reports the ones still missing", () => {
    const onMissing = vi.fn();
    const html = '<img src="cid:logo" alt="Logo"><img src="cid:chart" alt="Chart">';
    const { rerender } = render(<MessageBody html={html} text="" inlineImages={[{ contentId: "logo", dataUrl: PNG_DATA_URL }]} onMissingInlineImages={onMissing} />);
    expect(frameDocument().querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(onMissing).toHaveBeenLastCalledWith(["chart"]);
    expect(screen.queryByRole("status")).toBeNull();

    const both = [{ contentId: "logo", dataUrl: PNG_DATA_URL }, { contentId: "chart", dataUrl: PNG_DATA_URL }];
    rerender(<MessageBody html={html} text="" inlineImages={both} onMissingInlineImages={onMissing} />);
    expect(frameDocument().querySelectorAll("img").length).toBe(2);
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state instead of an empty frame", () => {
    render(<MessageBody html="<script>alert(1)</script>" text="   " />);
    expect(screen.queryByTitle("Message content")).toBeNull();
    expect(screen.getByText("This message has no content.")).toBeTruthy();
  });

  it("sizes the frame to the measured height of an inert copy", () => {
    const observed: Element[] = [];
    let notify: () => void = () => undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() { observed.length = 0; }
    });
    let height = 432;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("mx-root") ? height : 0;
    });
    const { container } = render(<MessageBody html={`<p>Hello</p><a href="https://example.com/" style="color:red">link</a><img src="${PNG_DATA_URL}" alt="dot" width="10">`} text="" />);
    expect(frame().style.height).toBe("433px");

    const host = container.querySelector<HTMLElement>(".mx-message-body__measure");
    expect(host?.getAttribute("aria-hidden")).toBe("true");
    expect(host?.hasAttribute("inert")).toBe(true);
    const copy = host?.shadowRoot?.querySelector(".mx-root");
    expect(copy?.textContent).toContain("Hello");
    expect(copy?.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(copy?.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(observed).toContain(copy);

    height = 900;
    act(() => notify());
    expect(frame().style.height).toBe("901px");
  });

  it("falls back to a scrolling frame when nothing can be measured", () => {
    render(<MessageBody html="<p>Hello</p>" text="" minHeight={120} />);
    expect(frame().style.height).toBe("120px");
  });
});

describe("buildLayoutProjection", () => {
  it("copies layout only: no links, no handlers, no text alternatives, no unknown elements", () => {
    const root = buildLayoutProjection(
      '<div class="a" onclick="alert(1)" title="t" style="color:red;position:fixed;width:10px"><a href="https://example.com/" target="_blank" onmouseover="alert(1)">x</a>' +
        '<script>alert(1)</script><iframe src="https://evil.example/"></iframe><form action="/x"><input></form><svg onload="alert(1)"></svg>' +
        `<img src="${PNG_DATA_URL}" alt="a" onerror="alert(1)" width="20"><img src="javascript:alert(1)"><img src="https://cdn.example/a.png">` +
        '<table cellpadding="4"><tbody><tr><td colspan="2" background="https://evil.example/">y</td></tr></tbody></table></div>',
      document,
    );
    expect(root.querySelectorAll("script, iframe, form, input, svg, style, link, meta").length).toBe(0);
    for (const element of Array.from(root.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(["class", "style", "width", "height", "colspan", "cellpadding", "src", "referrerpolicy"]).toContain(attribute.name);
        expect(attribute.name.startsWith("on")).toBe(false);
      }
    }
    expect(root.querySelector("div.a")?.getAttribute("style")).toBe("color:red;width:10px");
    expect(Array.from(root.querySelectorAll("img")).map((image) => image.getAttribute("src"))).toEqual([PNG_DATA_URL, "https://cdn.example/a.png"]);
    expect(root.querySelector("td")?.getAttribute("colspan")).toBe("2");
    expect(root.textContent).toBe("xy");
  });
});

describe("buildFrameDocument", () => {
  it("refuses theme values and sheets that could break out of the style element", () => {
    const srcdoc = buildFrameDocument({
      html: "<p>x</p>",
      css: "p{color:red}</style><script>alert(1)</script>",
      theme: { ...DEFAULT_FRAME_THEME, foreground: "red;}</style><script>alert(1)</script>", fontFamily: "x;} body{display:none}" },
      allowRemoteImages: false,
    });
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(doc.querySelector("script")).toBeNull();
    expect(srcdoc).not.toContain("alert(1)");
    expect(srcdoc).not.toContain("display:none}");
    expect(srcdoc).toContain(DEFAULT_FRAME_THEME.foreground);
    expect(doc.querySelector(".mx-root p")?.textContent).toBe("x");
  });

  it("uses the theme it is given", () => {
    const srcdoc = buildFrameDocument({
      html: "<p>x</p>",
      css: ".a{color:blue}",
      theme: { ...DEFAULT_FRAME_THEME, scheme: "dark", foreground: "rgb(238, 241, 247)", background: "rgb(20, 25, 35)", link: "oklch(0.7 0.1 250)" },
      allowRemoteImages: true,
    });
    expect(srcdoc).toContain("color:rgb(238, 241, 247)");
    expect(srcdoc).toContain("background:rgb(20, 25, 35)");
    expect(srcdoc).toContain("color-scheme:dark");
    expect(srcdoc).toContain("oklch(0.7 0.1 250)");
    expect(srcdoc).toContain(".a{color:blue}");
    expect(srcdoc).toContain(frameContentSecurityPolicy(true));
  });
});
