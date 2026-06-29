import { source } from '@/lib/source';
import { getBlogPostUrl, getBlogPosts } from '@/lib/blog';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages();
  const posts = getBlogPosts();
  const lines = [
    '# Matrix OS Documentation',
    '',
    '> Matrix OS is an AI-native operating system where software is generated from conversation.',
    '',
    ...pages.map((p) => `- [${p.data.title}](${p.url}): ${p.data.description ?? ''}`),
    '',
    '## Blog',
    '',
    ...posts.map((p) => `- [${p.title}](${getBlogPostUrl(p)}): ${p.description}`),
  ];

  return new Response(lines.join('\n'));
}
