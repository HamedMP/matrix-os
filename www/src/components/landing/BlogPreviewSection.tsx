import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { BlogCard } from "@/components/blog/BlogChrome";
import { getFeaturedBlogPosts } from "@/lib/blog";
import { palette as c, fonts } from "./theme";

export function BlogPreviewSection() {
  const posts = getFeaturedBlogPosts(3);

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 py-14 md:px-10 md:py-20">
      <div className="mb-8 flex flex-col gap-5 md:mb-10 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em]" style={{ color: c.ember }}>
            From the blog
          </p>
          <h2 className="max-w-[720px] text-4xl font-normal leading-tight md:text-5xl" style={{ fontFamily: fonts.display }}>
            Notes on cloud computers, agents, and Web 4.
          </h2>
        </div>
        <Link
          href="/blog"
          className="inline-flex w-fit items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition hover:bg-white"
          style={{ borderColor: c.border, color: c.deep }}
        >
          View all posts
          <ArrowRightIcon className="size-4" strokeWidth={1.75} />
        </Link>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {posts.map((post) => (
          <BlogCard key={post.info.path} post={post} />
        ))}
      </div>
    </section>
  );
}
