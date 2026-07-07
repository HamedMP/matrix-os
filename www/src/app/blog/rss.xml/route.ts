import { getBlogPostCanonicalUrl, getBlogPostMarkdown, getBlogPosts } from "@/lib/blog";

export const revalidate = false;

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeCdata(value: string) {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

export async function GET() {
  const posts = getBlogPosts();
  const items = await Promise.all(
    posts.map(async (post) => {
      const markdown = await getBlogPostMarkdown(post);
      const url = getBlogPostCanonicalUrl(post);
      return [
        "<item>",
        `<title>${escapeXml(post.title)}</title>`,
        `<link>${escapeXml(url)}</link>`,
        `<guid>${escapeXml(url)}</guid>`,
        `<description>${escapeXml(post.description)}</description>`,
        `<author>${escapeXml(post.author)}</author>`,
        `<category>${escapeXml(post.category)}</category>`,
        `<pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
        `<content:encoded><![CDATA[${escapeCdata(markdown)}]]></content:encoded>`,
        "</item>",
      ].join("\n");
    }),
  );

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    "<channel>",
    "<title>Matrix OS Blog</title>",
    "<link>https://matrix-os.com/blog</link>",
    "<description>Field notes on AI-native computing, cloud computers, background agents, and Web 4.</description>",
    "<language>en</language>",
    `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    ...items,
    "</channel>",
    "</rss>",
  ].join("\n");

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}
