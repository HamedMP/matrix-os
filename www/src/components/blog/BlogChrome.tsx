import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { Logo } from "@/components/landing/Logo";
import { palette as c, cardShadow, cardShadowSmall, fonts } from "@/components/landing/theme";
import type { BlogPost } from "@/lib/blog";
import { formatBlogDate, getBlogPostUrl } from "@/lib/blog";

export function BlogShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col" style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <div className="flex-1">
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}

export function BlogIndexHero() {
  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 pt-20 pb-10 md:px-10 md:pt-28">
      <div className="grid gap-8 lg:grid-cols-[1.08fr_0.92fr] lg:items-end">
        <div>
          <Link
            href="/"
            className="mb-7 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition hover:bg-white"
            style={{ borderColor: c.border, color: c.mutedFg }}
          >
            <Logo className="size-4" style={{ color: c.forest }} />
            Matrix OS field notes
          </Link>
          <h1 className="max-w-[820px] text-5xl font-normal leading-[0.98] md:text-7xl" style={{ fontFamily: fonts.display }}>
            Essays from the edge of AI-native computing.
          </h1>
        </div>
        <p className="max-w-[560px] text-lg leading-8 md:text-xl" style={{ color: c.mutedFg }}>
          Product thinking, engineering notes, release stories, and the operating-system ideas behind Matrix.
          Written for people building with agents, cloud computers, and persistent workspaces.
        </p>
      </div>
    </section>
  );
}

export function BlogCard({ post, priority = false }: { post: BlogPost; priority?: boolean }) {
  return (
    <Link
      href={getBlogPostUrl(post)}
      className="group flex flex-col rounded-2xl border p-6 transition duration-200 hover:-translate-y-1 md:p-7"
      style={{
        backgroundColor: c.card,
        borderColor: c.border,
        boxShadow: priority ? cardShadow : cardShadowSmall,
      }}
    >
      <div className="mb-8 flex flex-wrap items-center gap-2 text-sm" style={{ color: c.subtle }}>
        <span className="rounded-full px-3 py-1" style={{ backgroundColor: "rgba(67,78,63,0.08)", color: c.forest }}>
          {post.category}
        </span>
        <span>{formatBlogDate(post.publishedAt)}</span>
        <span aria-hidden="true">/</span>
        <span>{post.readTime}</span>
      </div>
      <h2 className="text-3xl font-normal leading-tight md:text-4xl" style={{ fontFamily: fonts.display }}>
        {post.title}
      </h2>
      <p className="mt-5 flex-1 text-base leading-7" style={{ color: c.mutedFg }}>
        {post.description}
      </p>
      <span className="mt-8 inline-flex items-center gap-2 text-sm font-medium" style={{ color: c.deep }}>
        Read article
        <ArrowRightIcon className="size-4 transition group-hover:translate-x-1" strokeWidth={1.75} />
      </span>
    </Link>
  );
}

export function BlogPostMeta({ post }: { post: BlogPost }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: c.subtle }}>
      <span>{post.author}</span>
      <span aria-hidden="true">/</span>
      <time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt)}</time>
      <span aria-hidden="true">/</span>
      <span>{post.readTime}</span>
    </div>
  );
}
