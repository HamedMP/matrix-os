import { escapeHtml, splitParts, validUrl } from "./shared.mjs";

function meta(name, content, property = false) { return `<meta ${property ? "property" : "name"}="${name}" content="${escapeHtml(content)}">`; }
function xml(value) { return escapeHtml(value).replaceAll("&#39;", "&apos;"); }

export function seoTool(slug, input) {
  switch (slug) {
    case "meta-tag-generator": {
      const [title, description, address] = splitParts(input, 3), url = validUrl(address);
      return [`<title>${escapeHtml(title)}</title>`, meta("description", description), `<link rel="canonical" href="${escapeHtml(url.href)}">`, meta("og:title", title, true), meta("og:description", description, true), meta("og:url", url.href, true), meta("twitter:card", "summary_large_image")].join("\n");
    }
    case "robots-txt-generator": return `User-agent: *\nAllow: /\n\nSitemap: ${validUrl(input).href}`;
    case "sitemap-xml-generator": {
      const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length || lines.length > 1000) throw new Error("Enter 1 to 1,000 URLs.");
      const urls = [...new Set(lines.map((line) => validUrl(line, { httpsOnly: true }).href))];
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${xml(url)}</loc></url>`).join("\n")}\n</urlset>`;
    }
    case "canonical-url-generator": {
      const url = validUrl(input); url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|msclkid$|mc_)/i.test(key)) url.searchParams.delete(key);
      return url.href;
    }
    case "hreflang-generator": {
      const rows = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (rows.length > 50) throw new Error("Use no more than 50 alternate pages.");
      const seen = new Set(); return rows.map((line) => {
        const [language, address] = splitParts(line, 2);
        if (!/^(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?|x-default)$/.test(language) || seen.has(language)) throw new Error("Use unique, valid language codes.");
        seen.add(language); return `<link rel="alternate" hreflang="${language}" href="${escapeHtml(validUrl(address).href)}">`;
      }).join("\n");
    }
    case "utm-builder": {
      const [address, source, medium, campaign] = splitParts(input, 4), url = validUrl(address);
      url.searchParams.set("utm_source", source); url.searchParams.set("utm_medium", medium); url.searchParams.set("utm_campaign", campaign);
      return url.href;
    }
    case "title-length-checker": return `Characters: ${[...input].length}\nPreview: ${input.trim()}\nReview whether the title clearly names the page; search engines may rewrite it.`;
    case "meta-description-checker": return `Characters: ${[...input].length}\nPreview: ${input.trim()}\nWrite for a human searcher; snippets may be rewritten.`;
    case "social-preview": {
      const [title, description, address, image] = splitParts(input, 4), url = validUrl(address), picture = validUrl(image);
      return [meta("og:type", "website", true), meta("og:title", title, true), meta("og:description", description, true), meta("og:url", url.href, true), meta("og:image", picture.href, true), meta("twitter:card", "summary_large_image"), meta("twitter:title", title), meta("twitter:description", description), meta("twitter:image", picture.href)].join("\n");
    }
    case "schema-jsonld-generator": {
      const [type, name, address, description] = splitParts(input, 4);
      if (!["Organization", "SoftwareApplication"].includes(type)) throw new Error("Choose Organization or SoftwareApplication.");
      return JSON.stringify({ "@context": "https://schema.org", "@type": type, name, url: validUrl(address).href, description }, null, 2);
    }
    case "html-seo-audit": {
      const title = input.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
      const description = input.match(/<meta\s+[^>]*name=["']description["'][^>]*>/i)?.[0] ?? input.match(/<meta\s+[^>]*content=["'][^"']*["'][^>]*name=["']description["'][^>]*>/i)?.[0];
      const canonical = /<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(input);
      const h1 = [...input.matchAll(/<h1\b/gi)].length;
      const noindex = /<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(input);
      return [`Title: ${title ? `${title.replace(/<[^>]*>/g, "")} (${title.length} characters)` : "Missing"}`, `Meta description: ${description ? "Present" : "Missing"}`, `H1 headings: ${h1}`, `Canonical tag: ${canonical ? "Present" : "Missing"}`, `Noindex directive: ${noindex ? "Found" : "Not found"}`, "Static pasted-HTML check only."].join("\n");
    }
    default: throw new Error("Unknown SEO tool.");
  }
}
