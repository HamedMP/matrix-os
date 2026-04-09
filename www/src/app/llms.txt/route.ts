import { source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages();
  const lines = [
    '# Matrix OS Documentation',
    '',
    '> Matrix OS is an AI-native operating system where software is generated from conversation.',
    '',
    ...pages.map((p) => `- [${p.data.title}](${p.url}): ${p.data.description ?? ''}`),
  ];

  return new Response(lines.join('\n'));
}
