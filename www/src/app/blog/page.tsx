import type { Metadata } from "next";
import { headers } from "next/headers";
import { BlogCard, BlogIndexHero, BlogShell } from "@/components/blog/BlogChrome";
import { getBlogPosts } from "@/lib/blog";
import { palette as c } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Blog | Matrix OS",
  description:
    "Field notes from Matrix OS on AI-native computing, cloud computers, background agents, and Web 4.",
  alternates: {
    canonical: "/blog",
    types: {
      "application/rss+xml": "/blog/rss.xml",
    },
  },
  openGraph: {
    title: "Matrix OS Blog",
    description:
      "Product thinking, engineering notes, release stories, and operating-system ideas behind Matrix OS.",
    url: "https://matrix-os.com/blog",
    siteName: "Matrix OS",
    type: "website",
    images: ["/opengraph-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Matrix OS Blog",
    description:
      "Field notes on AI-native computing, cloud computers, background agents, and Web 4.",
    images: ["/opengraph-image.png"],
  },
};

export default async function BlogIndexPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const posts = getBlogPosts();
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Matrix OS Blog",
    description: metadata.description,
    url: "https://matrix-os.com/blog",
    publisher: {
      "@type": "Organization",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      logo: "https://matrix-os.com/rabbit.svg",
    },
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt ?? post.publishedAt,
      author: { "@type": "Organization", name: post.author },
      url: `https://matrix-os.com/blog/${post.info.path.replace(/\.mdx$/, "")}`,
    })),
  });

  return (
    <BlogShell>
      {/* react-doctor-disable-next-line react-doctor/no-danger -- jsonLd is JSON.stringify of static MDX frontmatter from the repository */}
      <script
        id="blog-json-ld"
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <main>
        <BlogIndexHero />
        <section className="mx-auto w-full max-w-[1400px] px-5 pb-20 md:px-10 md:pb-28">
          {posts.length > 0 ? (
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {posts.map((post) => (
                <BlogCard key={post.info.path} post={post} priority={post.featured} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border p-8" style={{ backgroundColor: c.card, borderColor: c.border }}>
              No posts published yet.
            </div>
          )}
        </section>
      </main>
    </BlogShell>
  );
}
