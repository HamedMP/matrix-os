import { blog } from 'fumadocs-mdx:collections/server';

export type BlogPost = (typeof blog)[number];

export function getBlogSlug(post: BlogPost) {
  return post.info.path.replace(/(?:\/index)?\.mdx$/, '');
}

export function getBlogPostUrl(post: BlogPost) {
  return `/blog/${getBlogSlug(post)}`;
}

export function getBlogPostCanonicalUrl(post: BlogPost) {
  return `https://matrix-os.com${getBlogPostUrl(post)}`;
}

export function getBlogPosts() {
  return [...blog].sort((a, b) => {
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
}

export function getFeaturedBlogPosts(limit = 3) {
  const posts = getBlogPosts();
  const featured = posts.filter((post) => post.featured);
  return (featured.length > 0 ? featured : posts).slice(0, limit);
}

export function getBlogPost(slug: string) {
  return getBlogPosts().find((post) => getBlogSlug(post) === slug);
}

export function formatBlogDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export async function getBlogPostMarkdown(post: BlogPost) {
  return post.getText('processed').catch(() => post.getText('raw'));
}
