import { describe, expect, it, vi } from "vitest";
import { createSafeDataUrlPreview } from "../../packages/gateway/src/integrations/refresh/url-preview.js";
import { createIntegrationRefreshRoutes } from "../../packages/gateway/src/integrations/refresh/routes.js";
import type { IntegrationRefreshService } from "../../packages/gateway/src/integrations/refresh/service.js";
const resolver = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
describe("selected URL preview", () => {
  it("passes a validated pinned address and returns bounded inert page metadata", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, contentType: "text/html; charset=utf-8", body: '<title>Budget &amp; notes</title><meta name="description" content="A planning page"><script>danger()</script><p>Useful notes</p>' });
    const preview = createSafeDataUrlPreview({ resolver, transport });
    expect(await preview("https://docs.google.com/report")).toEqual({ url: "https://docs.google.com/report", title: "Budget & notes", description: "A planning page" });
    expect(transport.mock.calls[0][0]).toMatchObject({ address: "8.8.8.8", family: 4 });
  });
  it("rejects private DNS, credentials, non-HTTPS and redirects before exposing metadata", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 302, contentType: "text/html", body: "redirect" });
    const preview = createSafeDataUrlPreview({ resolver, transport });
    for (const url of ["http://google.com", "https://user:pass@google.com", "https://127.0.0.1", "https://metadata.google.internal"]) await expect(preview(url)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await expect(preview("https://google.com")).rejects.toThrow();
    const internal = createSafeDataUrlPreview({ resolver: async () => [{ address: "10.0.0.2", family: 4 }], transport });
    await expect(internal("https://google.com")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("caps response bytes, drops HTML from titles, and rejects binary responses", async () => {
    const transport = vi.fn().mockResolvedValueOnce({ status: 200, contentType: "text/html", body: "x".repeat(512 * 1024 + 1) })
      .mockResolvedValueOnce({ status: 200, contentType: "application/octet-stream", body: "binary" })
      .mockResolvedValueOnce({ status: 200, contentType: "text/html", body: '<title><b>Hello</b></title><meta property="og:description" content=" &lt;script&gt;ignored&lt;/script&gt; ">' });
    const preview = createSafeDataUrlPreview({ resolver, transport });
    await expect(preview("https://google.com")).rejects.toThrow();
    await expect(preview("https://google.com")).rejects.toThrow();
    expect(await preview("https://google.com")).toMatchObject({ title: "Hello", description: "ignored" });
  });
  it("retains literal angle brackets in plain-text responses", async () => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/plain", body: "A <literal> field &amp; another\nline" }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "google.com", description: "A <literal> field & another line" });
  });
  it.each([
    { name: "double-quoted descriptions", tag: '<meta name="description" content="Revenue > last year">', description: "Revenue > last year" },
    { name: "single-quoted descriptions", tag: "<meta name='description' content='Revenue > last year'>", description: "Revenue > last year" },
    { name: "comparison signs in other attributes", tag: '<meta data-note="Q > 0 < 1" name="description" content="Safe metadata">', description: "Safe metadata" },
    { name: "literal markup inside an attribute", tag: '<meta name="description" content="Revenue <b>today</b> > yesterday">', description: "Revenue today > yesterday" },
    { name: "encoded markup with quoted comparison signs", tag: '<meta name="description" content="Revenue &lt;b data-note=\'a > b\'&gt;today&lt;/b&gt; > yesterday">', description: "Revenue today > yesterday" },
  ])("retains bounded metadata for $name", async ({ tag, description }) => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body: `<title>Budget</title>${tag}` }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "Budget", description });
  });
  it("reads titles with comparison signs inside quoted attributes", async () => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body: '<title data-note="Q > 0 < 1">Budget</title><meta name="description" content="Safe metadata">' }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "Budget", description: "Safe metadata" });
  });
  it.each([
    "<!-- It's normal to compare > estimates -->",
    '<!-- <meta name="description" content="Incorrect"> -->',
  ])("ignores comment contents while scanning metadata: %s", async comment => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body: `<title>Budget</title>${comment}<meta name="description" content="Safe metadata">` }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "Budget", description: "Safe metadata" });
  });
  it.each(["script", "style", "SCRIPT", "STYLE"])("ignores fake metadata and titles in %s raw text", async element => {
    const body = `<${element} data-note="1 > 0">example = '<title>Wrong title</title><meta name="description" content="Wrong description">'; </${element}><title>Budget</title><meta name="description" content="Safe metadata">`;
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "Budget", description: "Safe metadata" });
  });
  it.each(["script", "style"])("does not scan metadata after an unclosed %s element", async element => {
    const body = `<${element}><meta name="description" content="Wrong description"><title>Wrong title</title>`;
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "google.com", description: "" });
  });
  it("recognizes raw-text closing tag boundaries and quoted attributes", async () => {
    const body = `<script>const example = '</scripture><meta name="description" content="Wrong">';</ScRiPt data-note="1 > 0"><title>Budget</title><meta name="description" content="Safe metadata">`;
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "Budget", description: "Safe metadata" });
  });
  it.each([
    { name: "unmatched plain-text brackets", contentType: "text/plain", body: "<".repeat(512 * 1024), title: "google.com", description: "<".repeat(500) },
    { name: "unmatched title tags", contentType: "text/html", body: "<title".repeat(87000), title: "google.com", description: "" },
    { name: "unclosed complete title tags", contentType: "text/html", body: "<title>".repeat(74000), title: "google.com", description: "" },
    { name: "title containing unmatched brackets", contentType: "text/html", body: "<title>" + "<".repeat(510 * 1024) + "</title><meta name=\"description\" content=\"Safe &amp; inert\">", title: "<".repeat(200), description: "Safe & inert" },
    { name: "unclosed quoted metadata", contentType: "text/html", body: '<title>Budget</title><meta name="description" content="' + "<".repeat(510 * 1024), title: "Budget", description: "" },
  ])("returns exact bounded metadata for $name", async ({ contentType, body, title, description }) => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType, body }) });
    const app = createIntegrationRefreshRoutes({ service: {} as IntegrationRefreshService, resolveOwner: async () => "owner", urlPreview: preview });
    const response = await app.request("/url-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://google.com" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://google.com/", title, description });
  });
  it("caps decoded rendered metadata and removes inert markup in bounded candidates", async () => {
    const preview = createSafeDataUrlPreview({ resolver, transport: async () => ({ status: 200, contentType: "text/html", body: `<title><b>${"&#65;".repeat(400)}</b></title><meta property="og:description" content="${"&#x42;".repeat(600)}">` }) });
    expect(await preview("https://google.com")).toEqual({ url: "https://google.com/", title: "A".repeat(200), description: "B".repeat(500) });
  });
});
