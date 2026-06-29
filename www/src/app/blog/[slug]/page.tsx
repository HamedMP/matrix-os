import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { InlineTOC } from "fumadocs-ui/components/inline-toc";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { BlogPostActions } from "@/components/blog/BlogPostActions";
import { BlogTableOfContents } from "@/components/blog/BlogTableOfContents";
import { BlogPostMeta, BlogShell } from "@/components/blog/BlogChrome";
import { Mermaid } from "@/components/mdx/mermaid";
import { formatBlogDate, getBlogPost, getBlogPostCanonicalUrl, getBlogPostUrl, getBlogPosts } from "@/lib/blog";
import { palette as c, fonts } from "@/components/landing/theme";

export function generateStaticParams() {
  return getBlogPosts().map((post) => ({
    slug: getBlogPostUrl(post).replace("/blog/", ""),
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const post = getBlogPost(slug);

  if (!post) notFound();

  return {
    title: `${post.title} | Matrix OS Blog`,
    description: post.description,
    keywords: post.keywords,
    alternates: {
      canonical: getBlogPostUrl(post),
    },
    openGraph: {
      title: post.title,
      description: post.description,
      url: getBlogPostCanonicalUrl(post),
      siteName: "Matrix OS",
      type: "article",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt ?? post.publishedAt,
      authors: [post.author],
      images: ["/opengraph-image.png"],
      tags: post.keywords,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: ["/opengraph-image.png"],
    },
  };
}

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const post = getBlogPost(slug);

  if (!post) notFound();

  const Mdx = post.body;
  const toc = post.toc;
  const canonicalUrl = getBlogPostCanonicalUrl(post);
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt ?? post.publishedAt,
    mainEntityOfPage: canonicalUrl,
    url: canonicalUrl,
    image: "https://matrix-os.com/opengraph-image.png",
    keywords: post.keywords,
    articleSection: post.category,
    author: {
      "@type": "Organization",
      name: post.author,
      url: "https://matrix-os.com",
    },
    publisher: {
      "@type": "Organization",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      logo: "https://matrix-os.com/rabbit.svg",
    },
  });

  return (
    <BlogShell>
      {/* react-doctor-disable-next-line react-doctor/no-danger -- jsonLd is JSON.stringify of static MDX frontmatter from the repository */}
      <script
        id="blog-post-json-ld"
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <main>
        <article className="mx-auto w-full max-w-[1240px] px-5 pt-20 pb-20 md:px-10 md:pt-28 md:pb-28">
          <div className="grid gap-12 xl:grid-cols-[minmax(0,780px)_240px] xl:items-start xl:gap-16">
            <div>
              <header className="mb-10 border-b pb-10 md:mb-10 md:pb-12" style={{ borderColor: c.border }}>
                <div className="mb-8 grid gap-5 rounded-2xl border bg-white/35 p-5 sm:grid-cols-[1fr_1fr_auto]" style={{ borderColor: c.border }}>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: c.subtle }}>
                      Written by
                    </p>
                    <p className="mt-2 text-sm font-medium" style={{ color: c.deep }}>
                      {post.author}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: c.subtle }}>
                      At
                    </p>
                    <p className="mt-2 text-sm font-medium" style={{ color: c.deep }}>
                      <time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt)}</time>
                    </p>
                  </div>
                  <div className="sm:justify-self-end">
                    <BlogPostActions url={canonicalUrl} />
                  </div>
                </div>
                <p className="mb-5 text-sm font-medium uppercase tracking-[0.16em]" style={{ color: c.ember }}>
                  {post.category}
                </p>
                <h1 className="max-w-[920px] text-5xl font-normal leading-[0.98] md:text-7xl" style={{ fontFamily: fonts.display }}>
                  {post.title}
                </h1>
                <p className="mt-7 max-w-[760px] text-lg leading-8 md:text-xl" style={{ color: c.mutedFg }}>
                  {post.description}
                </p>
                <div className="mt-7">
                  <BlogPostMeta post={post} />
                </div>
              </header>

              {toc.length > 0 ? (
                <InlineTOC
                  items={toc}
                  className="mb-10 border bg-white/55 shadow-[0_1rem_3rem_rgba(50,53,46,0.06)] xl:hidden"
                  style={{ borderColor: c.border }}
                >
                  On this page
                </InlineTOC>
              ) : null}

              <style>{`
                .blog-prose {
                  color: ${c.deep};
                  font-size: 1.0625rem;
                  line-height: 1.9;
                }
                .blog-prose > * + * { margin-top: 1.45rem; }
                .blog-prose h2 {
                  margin-top: 3rem;
                  color: ${c.deep};
                  font-family: ${fonts.display};
                  font-size: clamp(2rem, 4vw, 3rem);
                  font-weight: 400;
                  line-height: 1.08;
                }
                .blog-prose h3 {
                  margin-top: 2.25rem;
                  color: ${c.deep};
                  font-size: 1.35rem;
                  font-weight: 600;
                  line-height: 1.25;
                }
                .blog-prose h2 a,
                .blog-prose h3 a {
                  color: inherit;
                  text-decoration: none;
                }
                .blog-prose p,
                .blog-prose li {
                  max-width: 760px;
                  color: ${c.mutedFg};
                }
                .blog-prose a {
                  color: ${c.forest};
                  text-decoration: underline;
                  text-decoration-color: rgba(67, 78, 63, 0.25);
                  text-underline-offset: 0.2em;
                }
                .blog-prose ul,
                .blog-prose ol {
                  max-width: 760px;
                  padding-left: 1.35rem;
                }
                .blog-prose ul { list-style: disc; }
                .blog-prose ol { list-style: decimal; }
                .blog-prose li + li { margin-top: 0.55rem; }
                .blog-prose strong { color: ${c.deep}; }
                .blog-prose blockquote {
                  max-width: 820px;
                  margin-left: 0;
                  border-left: 3px solid ${c.ember};
                  padding: 0.2rem 0 0.2rem 1.35rem;
                  color: ${c.forestDeep};
                  font-family: ${fonts.display};
                  font-size: 1.65rem;
                  line-height: 1.35;
                }
                .blog-prose code {
                  border-radius: 0.35rem;
                  background: rgba(67, 78, 63, 0.09);
                  padding: 0.12rem 0.35rem;
                  color: ${c.forestDeep};
                  font-size: 0.92em;
                }
                .blog-prose pre {
                  max-width: 920px;
                  overflow-x: auto;
                  border-radius: 0.85rem;
                  background: ${c.deep};
                  padding: 1.15rem;
                  color: #F4F2E6;
                }
                .blog-prose pre code {
                  background: transparent;
                  padding: 0;
                  color: inherit;
                }
                .blog-prose hr {
                  margin: 3rem 0;
                  max-width: 760px;
                  border: 0;
                  border-top: 1px solid ${c.border};
                }
              `}</style>
              <div className="blog-prose">
                <Mdx components={{ ...defaultMdxComponents, Mermaid }} />
              </div>
            </div>

            <BlogTableOfContents items={toc} />
          </div>
        </article>
      </main>
    </BlogShell>
  );
}
