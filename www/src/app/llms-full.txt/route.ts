import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { getBlogPostMarkdown, getBlogPostUrl, getBlogPosts } from '@/lib/blog';

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const scanned = await Promise.all(scan);
  const blogScan = getBlogPosts().map(async (post) => {
    const markdown = await getBlogPostMarkdown(post);
    return [`# ${post.title}`, '', `URL: ${getBlogPostUrl(post)}`, '', post.description, '', markdown].join('\n');
  });
  const blogScanned = await Promise.all(blogScan);

  return new Response([...scanned, ...blogScanned].join('\n\n'));
}
